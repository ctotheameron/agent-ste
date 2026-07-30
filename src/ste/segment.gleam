import gleam/list
import gleam/option.{type Option, Some}
import gleam/regexp.{type Regexp}
import gleam/string

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

pub opaque type Splitter {
  Splitter(sentence: Regexp, marker: Regexp, list_marker: Regexp)
}

/// Group 1 takes leading whitespace, group 2 takes the sentence. A running sum
/// of both gives an exact offset, which gleam_regexp does not report.
const sentence_pattern = "(\\s*)([^.!?]*[.!?]+|[^.!?]+)"

const marker_pattern = "^\\s*(#{1,6}\\s+|[-*+]\\s+|\\d+[.)]\\s+|>\\s+)?"

const list_marker_pattern = "^(?:[-*+]\\s|\\d+[.)]\\s)"

pub fn splitter() -> Result(Splitter, Nil) {
  case
    regexp.from_string(sentence_pattern),
    regexp.from_string(marker_pattern),
    regexp.from_string(list_marker_pattern)
  {
    Ok(sentence), Ok(marker), Ok(list_marker) ->
      Ok(Splitter(sentence, marker, list_marker))
    _, _, _ -> Error(Nil)
  }
}

pub fn classify(splitter: Splitter, line: String) -> LineKind {
  let trimmed = string.trim(line)
  case trimmed {
    "" -> Blank
    _ ->
      case string.starts_with(trimmed, "|") {
        True -> TableRow
        False ->
          case string.starts_with(trimmed, "#") {
            True -> Heading
            False ->
              case regexp.check(splitter.list_marker, trimmed) {
                True -> ListItem
                False -> Prose
              }
          }
      }
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
  |> list.flat_map(fn(block) { sentences_of_block(splitter, block) })
}

/// Groups lines into blocks and joins each block with a single space.
///
/// A hard-wrapped sentence then reads as one string, so a length count and a
/// sentence count stay correct.
fn blocks(splitter: Splitter, text: String) -> List(Block) {
  string.split(text, on: "\n")
  |> list.index_map(fn(line, index) { #(line, index + 1) })
  |> list.fold(#([], []), fn(state, entry) {
    let #(done, current) = state
    let #(line, number) = entry
    case classify(splitter, line) {
      Blank | Heading | TableRow -> #(close(done, current), [])
      ListItem -> #(close(close(done, current), [#(line, number)]), [])
      Prose -> #(done, [#(line, number), ..current])
    }
  })
  |> fn(state) { close(state.0, state.1) }
  |> list.reverse
}

fn close(done: List(Block), collected: List(#(String, Int))) -> List(Block) {
  case list.reverse(collected) {
    [] -> done
    ordered -> [build_block(ordered), ..done]
  }
}

fn build_block(ordered: List(#(String, Int))) -> Block {
  let #(parts, placed, _) =
    list.fold(ordered, #([], [], 0), fn(state, entry) {
      let #(parts, placed, offset) = state
      let #(line, number) = entry
      let indent = leading_width(line)
      let body = string.trim(string.drop_start(line, indent))
      // A joined block separates lines with one space.
      let separator = case parts {
        [] -> 0
        _ -> 1
      }
      let start = offset + separator
      #(
        [body, ..parts],
        [Placed(number: number, indent: indent, offset: start), ..placed],
        start + string.length(body),
      )
    })

  let lines = list.reverse(placed)
  Block(
    text: list.reverse(parts) |> string.join(" "),
    lines: lines,
    line: case lines {
      [first, ..] -> first.number
      [] -> 1
    },
  )
}

fn leading_width(line: String) -> Int {
  string.length(line) - string.length(string.trim_start(line))
}

fn sentences_of_block(splitter: Splitter, block: Block) -> List(Sentence) {
  regexp.scan(splitter.sentence, block.text)
  |> list.fold(#([], 0), fn(state, match) {
    let #(done, position) = state
    case match.submatches {
      [leading, Some(body)] -> {
        let start = position + width(leading)
        let trimmed = string.trim(body)
        let next = case trimmed {
          "" -> done
          _ -> [place(block, start, trimmed), ..done]
        }
        #(next, start + string.length(body))
      }
      _ -> #(done, position)
    }
  })
  |> fn(state) { list.reverse(state.0) }
}

/// Maps an offset in the joined block text back to a real line and column.
fn place(block: Block, offset: Int, text: String) -> Sentence {
  let placed =
    list.fold(
      block.lines,
      Placed(number: block.line, indent: 0, offset: 0),
      fn(best, candidate) {
        case candidate.offset <= offset {
          True -> candidate
          False -> best
        }
      },
    )

  Sentence(
    text: text,
    line: placed.number,
    column: offset - placed.offset + placed.indent + 1,
    words: word_count(text),
  )
}

fn width(value: Option(String)) -> Int {
  case value {
    Some(text) -> string.length(text)
    _ -> 0
  }
}

/// Counts words the way a reader does. A hyphenated compound counts once, and a
/// bare number counts as a word.
pub fn word_count(text: String) -> Int {
  string.split(text, on: " ")
  |> list.filter(has_letter_or_digit)
  |> list.length
}

fn has_letter_or_digit(token: String) -> Bool {
  string.to_graphemes(string.lowercase(token))
  |> list.any(fn(grapheme) {
    string.contains("abcdefghijklmnopqrstuvwxyz0123456789", grapheme)
  })
}
