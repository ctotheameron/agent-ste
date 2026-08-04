import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/pair
import gleam/regexp.{type Regexp}
import gleam/result
import gleam/string
import ste/source.{type Line}

pub type Sentence {
  Sentence(text: String, line: Int, column: Int, words: Int)
}

pub type Paragraph {
  Paragraph(sentences: List(Sentence), line: Int)
}

pub type LineKind {
  Blank
  Heading
  TableRow
  ListItem
  Prose
}

/// One source line inside a block, with the offset where it starts in the
/// block's joined text.
type Placed {
  Placed(number: Int, indent: Int, offset: Int)
}

/// A run of lines that belong together, already joined into one string.
type Block {
  Block(text: String, lines: List(Placed), line: Int)
}

/// The blocks closed so far, and the run still open.
type Grouping {
  Grouping(done: List(Block), open: List(Line))
}

pub opaque type Splitter {
  Splitter(sentence: Regexp, list_marker: Regexp)
}

/// Group 1 takes leading whitespace, group 2 takes the sentence. A running sum
/// of both gives an exact offset, which gleam_regexp does not report.
const sentence_pattern = "(\\s*)([^.!?]*[.!?]+|[^.!?]+)"

const list_marker_pattern = "^(?:[-*+]\\s|\\d+[.)]\\s)"

pub fn splitter() -> Result(Splitter, Nil) {
  use sentence <- result.try(compile(sentence_pattern))
  use list_marker <- result.try(compile(list_marker_pattern))
  Ok(Splitter(sentence: sentence, list_marker: list_marker))
}

fn compile(pattern: String) -> Result(Regexp, Nil) {
  regexp.from_string(pattern)
  |> result.replace_error(Nil)
}

pub fn classify(splitter: Splitter, line: String) -> LineKind {
  let trimmed = string.trim(line)
  case string.first(trimmed) {
    Error(_) -> Blank
    Ok("|") -> TableRow
    Ok("#") -> Heading
    Ok(_) -> body_kind(splitter, trimmed)
  }
}

/// A line that starts no marker is a list item or plain prose.
fn body_kind(splitter: Splitter, trimmed: String) -> LineKind {
  case regexp.check(splitter.list_marker, trimmed) {
    True -> ListItem
    False -> Prose
  }
}

/// A paragraph is a run of prose lines.
///
/// A blank line, a heading and a table row all end it. A list item is its own
/// paragraph. STE asks a writer to REPLACE a long prose paragraph with a
/// vertical list. A rule that counts the list as one paragraph punishes the fix
/// it recommends.
pub fn paragraphs(splitter: Splitter, text: String) -> List(Paragraph) {
  blocks(splitter, text)
  |> list.map(fn(block) {
    Paragraph(sentences: sentences_of_block(splitter, block), line: block.line)
  })
}

pub fn sentences(splitter: Splitter, text: String) -> List(Sentence) {
  blocks(splitter, text)
  |> list.flat_map(sentences_of_block(splitter, _))
}

/// Groups lines into blocks and joins each block with a single space.
///
/// A hard-wrapped sentence then reads as one string, so a length count and a
/// sentence count stay correct.
fn blocks(splitter: Splitter, text: String) -> List(Block) {
  source.lines(text)
  |> list.fold(Grouping(done: [], open: []), fn(state, line) {
    group(splitter, state, line)
  })
  |> flush
  |> list.reverse
}

fn group(splitter: Splitter, state: Grouping, line: Line) -> Grouping {
  case classify(splitter, line.text) {
    Prose -> Grouping(..state, open: [line, ..state.open])
    Blank | Heading | TableRow -> Grouping(done: flush(state), open: [])
    ListItem -> Grouping(done: [build_block([line]), ..flush(state)], open: [])
  }
}

/// Closes the open run. The newest block comes first.
fn flush(state: Grouping) -> List(Block) {
  case list.reverse(state.open) {
    [] -> state.done
    ordered -> [build_block(ordered), ..state.done]
  }
}

fn build_block(lines: List(Line)) -> Block {
  Block(
    text: lines |> list.map(body) |> string.join(with: " "),
    lines: place_lines(lines),
    line: first_number(lines),
  )
}

/// A joined block separates lines with one space, so each body starts one
/// character after the body before it ends.
fn place_lines(lines: List(Line)) -> List(Placed) {
  lines
  |> list.map_fold(from: 0, with: fn(start, line) {
    let placed =
      Placed(number: line.number, indent: indent(line), offset: start)
    #(start + string.length(body(line)) + 1, placed)
  })
  |> pair.second
}

fn body(line: Line) -> String {
  string.trim(line.text)
}

fn indent(line: Line) -> Int {
  string.length(line.text) - string.length(string.trim_start(line.text))
}

fn first_number(lines: List(Line)) -> Int {
  lines
  |> list.first
  |> result.map(fn(line) { line.number })
  |> result.unwrap(or: 1)
}

fn sentences_of_block(splitter: Splitter, block: Block) -> List(Sentence) {
  regexp.scan(splitter.sentence, block.text)
  |> list.map_fold(from: 0, with: fn(position, match) {
    take_sentence(block, position, match)
  })
  |> pair.second
  |> option.values
}

/// Places one match and returns the offset where the next one starts.
fn take_sentence(
  block: Block,
  position: Int,
  match: regexp.Match,
) -> #(Int, Option(Sentence)) {
  case match.submatches {
    [leading, Some(text)] -> {
      let start = position + width(leading)
      let next = start + string.length(text)
      case string.trim(text) {
        "" -> #(next, None)
        trimmed -> #(next, Some(place(block, start, trimmed)))
      }
    }
    _ -> #(position, None)
  }
}

/// Maps an offset in the joined block text back to a real line and column.
fn place(block: Block, offset: Int, text: String) -> Sentence {
  let placed =
    block.lines
    |> list.filter(fn(one) { one.offset <= offset })
    |> list.last
    |> result.unwrap(or: Placed(number: block.line, indent: 0, offset: 0))

  Sentence(
    text: text,
    line: placed.number,
    column: offset - placed.offset + placed.indent + 1,
    words: word_count(text),
  )
}

fn width(value: Option(String)) -> Int {
  value
  |> option.map(string.length)
  |> option.unwrap(or: 0)
}

/// The caller lowercases the text, so this list holds lowercase only.
const word_characters = "abcdefghijklmnopqrstuvwxyz0123456789"

/// Counts words the way a reader does. A hyphenated compound counts once, and a
/// bare number counts as a word.
pub fn word_count(text: String) -> Int {
  string.split(text, on: " ")
  |> list.count(has_letter_or_digit)
}

fn has_letter_or_digit(word: String) -> Bool {
  string.to_graphemes(string.lowercase(word))
  |> list.any(fn(grapheme) { string.contains(word_characters, grapheme) })
}
