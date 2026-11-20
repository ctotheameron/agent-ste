//// Reads a bash command the way a shell splits it, and finds the prose that a
//// `gh pr` or `gh issue` command sends.
////
//// Which text counts is a rule about text, so it lives here beside the other
//// rules. A host only reads a file from disk, and it reports the result.
////
//// A word that holds a command substitution or a backtick has no known value.
//// The reader skips it. A skip gives a miss, and a miss costs less than a
//// false block.

import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp.{type Match}
import gleam/result
import gleam/string

/// One word of a command. `dynamic` marks a value that a shell computes.
/// `heredoc` marks a word that came from a `$(cat <<EOF ...)` body.
pub type Word {
  Word(value: String, dynamic: Bool, heredoc: Bool)
}

/// One simple command, with the text that a heredoc feeds to its stdin.
pub type Command {
  Command(words: List(Word), stdin: String)
}

/// A piece of prose that a `gh` command sends. A `file` means the text sits in
/// that path, and the host reads it.
pub type GhText {
  GhText(label: String, text: String, file: Option(String))
}

type Pending {
  Pending(delimiter: String, strip: Bool)
}

type Reader {
  Reader(
    done: List(Command),
    words: List(Word),
    stdin: String,
    word: Option(Word),
    pending: List(Pending),
  )
}

type Target {
  Target(noun: String, body: String, stdin: String)
}

type Flag {
  Flag(field: String, inline: Option(String))
}

const empty_word = Word("", False, False)

// `$(cat <<'EOF' ... EOF)`, the form a model uses to pass a long body.
const cat_pattern = "^\\$\\(\\s*cat\\s+<<-?\\s*(['\"]?)(\\w+)\\1[ \\t]*\\n([\\s\\S]*?)\\n[ \\t]*\\2[ \\t]*\\n?\\s*\\)"

const heredoc_pattern = "^(-?)[ \\t]*(['\"]?)(\\w+)\\2"

const flag_pattern = "^(?:--(title|body|body-file)(?:=([\\s\\S]*))?|-([tbF])(?:=?([\\s\\S]+))?)$"

// --- the shell reader ---

/// Splits a command into simple commands, each a list of words.
///
/// The reader knows quotes, operators, comments and heredocs, which is what a
/// `gh` call needs. It is not a shell.
pub fn commands(source: String) -> List(Command) {
  read_loop(Reader([], [], "", None, []), source)
  |> end_command
  |> fn(reader) { list.reverse(reader.done) }
}

fn read_loop(reader: Reader, rest: String) -> Reader {
  case string.pop_grapheme(rest) {
    Error(_) -> reader
    Ok(#(char, tail)) -> {
      let #(next, remaining) = step(reader, char, rest, tail)
      read_loop(next, remaining)
    }
  }
}

/// Handles the character at the head of `rest`. `tail` is `rest` without it.
fn step(
  reader: Reader,
  char: String,
  rest: String,
  tail: String,
) -> #(Reader, String) {
  case char {
    "\n" | "\r\n" -> end_line(reader, tail)
    " " | "\t" -> #(end_word(reader), tail)
    "#" if reader.word == None -> #(reader, drop_line(tail))
    ";" | "|" | "&" -> operator(reader, char, tail)
    "'" -> single_quote(reader, tail)
    "\"" -> double_quote(reader, tail)
    "`" -> backtick(reader, tail)
    "\\" -> escape(reader, tail)
    "$" -> dollar(reader, rest, tail)
    "<" -> redirect(reader, rest, tail)
    _ -> #(extend(reader, char), tail)
  }
}

fn operator(reader: Reader, char: String, tail: String) -> #(Reader, String) {
  let doubled = char != ";" && string.starts_with(tail, char)
  let remaining = case doubled {
    True -> string.drop_start(tail, 1)
    False -> tail
  }
  #(end_command(reader), remaining)
}

fn single_quote(reader: Reader, tail: String) -> #(Reader, String) {
  case string.split_once(tail, "'") {
    Ok(#(text, after)) -> #(extend(reader, text), after)
    Error(_) -> #(extend(reader, tail), "")
  }
}

fn double_quote(reader: Reader, tail: String) -> #(Reader, String) {
  let current = option.unwrap(reader.word, empty_word)
  let #(word, after) = double_loop(tail, current)
  #(Reader(..reader, word: Some(word)), after)
}

fn backtick(reader: Reader, tail: String) -> #(Reader, String) {
  #(mark_dynamic(reader), drop_through(tail, "`"))
}

fn escape(reader: Reader, tail: String) -> #(Reader, String) {
  case string.pop_grapheme(tail) {
    Ok(#("\n", after)) -> #(reader, after)
    Ok(#(next, after)) -> #(extend(reader, next), after)
    Error(_) -> #(reader, "")
  }
}

fn dollar(reader: Reader, rest: String, tail: String) -> #(Reader, String) {
  case string.starts_with(tail, "(") {
    True -> #(mark_dynamic(reader), skip_substitution(rest))
    False -> #(extend(reader, "$"), tail)
  }
}

/// `<<` opens a heredoc. `<<<` and a lone `<` are plain text.
fn redirect(reader: Reader, rest: String, tail: String) -> #(Reader, String) {
  case string.starts_with(rest, "<<") && !string.starts_with(rest, "<<<") {
    False -> #(extend(reader, "<"), tail)
    True -> heredoc_start(end_word(reader), string.drop_start(rest, 2))
  }
}

fn heredoc_start(reader: Reader, after: String) -> #(Reader, String) {
  case scan(heredoc_pattern, after) {
    Ok(match) -> #(
      Reader(..reader, pending: [
        Pending(group(match, 2), group(match, 0) == "-"),
        ..reader.pending
      ]),
      string.drop_start(after, string.length(match.content)),
    )
    Error(_) -> #(reader, after)
  }
}

/// A newline ends a command. A heredoc body starts on the next line.
fn end_line(reader: Reader, rest: String) -> #(Reader, String) {
  let ended = end_word(reader)
  let #(bodies, after) = read_bodies(list.reverse(ended.pending), rest, [])
  let fed = Reader(..ended, stdin: string.join(bodies, "\n"), pending: [])
  #(end_command(fed), after)
}

fn double_loop(rest: String, word: Word) -> #(Word, String) {
  case string.pop_grapheme(rest) {
    Error(_) -> #(word, "")
    Ok(#("\"", tail)) -> #(word, tail)
    Ok(#("\\", tail)) -> double_escape(tail, word)
    Ok(#("$", tail)) -> double_dollar(rest, tail, word)
    Ok(#("`", tail)) ->
      double_loop(drop_through(tail, "`"), Word(..word, dynamic: True))
    Ok(#(char, tail)) -> double_loop(tail, append(word, char))
  }
}

/// A backslash in double quotes only escapes `"`, `\`, `$`, a backtick and a
/// newline. Before any other character it stays a backslash.
fn double_escape(tail: String, word: Word) -> #(Word, String) {
  case string.pop_grapheme(tail) {
    Ok(#("\n", after)) -> double_loop(after, word)
    Ok(#(next, after)) ->
      case list.contains(["\"", "\\", "$", "`"], next) {
        True -> double_loop(after, append(word, next))
        False -> double_loop(tail, append(word, "\\"))
      }
    Error(_) -> #(word, "")
  }
}

fn double_dollar(rest: String, tail: String, word: Word) -> #(Word, String) {
  case string.starts_with(tail, "("), scan(cat_pattern, rest) {
    True, Ok(match) ->
      double_loop(
        string.drop_start(rest, string.length(match.content)),
        Word(..append(word, group(match, 2)), heredoc: True),
      )
    True, Error(_) ->
      double_loop(skip_substitution(rest), Word(..word, dynamic: True))
    False, _ -> double_loop(tail, append(word, "$"))
  }
}

/// The text after the `)` that closes the `$(` at the head of `rest`.
fn skip_substitution(rest: String) -> String {
  substitution_loop(string.drop_start(rest, 1), 0)
}

fn substitution_loop(rest: String, depth: Int) -> String {
  case string.pop_grapheme(rest) {
    Error(_) -> ""
    Ok(#("(", tail)) -> substitution_loop(tail, depth + 1)
    Ok(#(")", tail)) if depth <= 1 -> tail
    Ok(#(")", tail)) -> substitution_loop(tail, depth - 1)
    Ok(#(_, tail)) -> substitution_loop(tail, depth)
  }
}

/// Reads one body for each pending heredoc, in the order of the redirects.
fn read_bodies(
  pending: List(Pending),
  rest: String,
  bodies: List(String),
) -> #(List(String), String) {
  case pending {
    [] -> #(list.reverse(bodies), rest)
    [Pending(delimiter, strip), ..others] -> {
      let #(body, after) = body_loop(rest, delimiter, strip, [])
      read_bodies(others, after, [body, ..bodies])
    }
  }
}

fn body_loop(
  rest: String,
  delimiter: String,
  strip: Bool,
  lines: List(String),
) -> #(String, String) {
  case rest {
    "" -> #(string.join(list.reverse(lines), "\n"), "")
    _ -> {
      let #(line, after) =
        string.split_once(rest, "\n") |> result.unwrap(#(rest, ""))
      let name = case strip {
        True -> drop_tabs(line)
        False -> line
      }
      case name == delimiter {
        True -> #(string.join(list.reverse(lines), "\n"), after)
        False -> body_loop(after, delimiter, strip, [line, ..lines])
      }
    }
  }
}

fn drop_tabs(line: String) -> String {
  case string.starts_with(line, "\t") {
    True -> drop_tabs(string.drop_start(line, 1))
    False -> line
  }
}

fn drop_line(rest: String) -> String {
  case string.split_once(rest, "\n") {
    Ok(#(_, after)) -> "\n" <> after
    Error(_) -> ""
  }
}

fn drop_through(rest: String, mark: String) -> String {
  case string.split_once(rest, mark) {
    Ok(#(_, after)) -> after
    Error(_) -> ""
  }
}

// --- the reader state ---

fn append(word: Word, text: String) -> Word {
  Word(..word, value: word.value <> text)
}

fn extend(reader: Reader, text: String) -> Reader {
  let word = option.unwrap(reader.word, empty_word)
  Reader(..reader, word: Some(append(word, text)))
}

fn mark_dynamic(reader: Reader) -> Reader {
  let word = option.unwrap(reader.word, empty_word)
  Reader(..reader, word: Some(Word(..word, dynamic: True)))
}

fn end_word(reader: Reader) -> Reader {
  case reader.word {
    Some(word) -> Reader(..reader, words: [word, ..reader.words], word: None)
    None -> reader
  }
}

/// Closes the command in progress. A heredoc that follows a `&&` on the same
/// line feeds the command before it, so an empty command is not stored.
fn end_command(reader: Reader) -> Reader {
  let ended = end_word(reader)
  case ended.words, ended.stdin {
    [], "" -> ended
    [], stdin -> Reader(..ended, done: feed(ended.done, stdin), stdin: "")
    words, stdin ->
      Reader(
        ..ended,
        done: [Command(list.reverse(words), stdin), ..ended.done],
        words: [],
        stdin: "",
      )
  }
}

fn feed(done: List(Command), stdin: String) -> List(Command) {
  case done {
    [Command(words, _), ..others] -> [Command(words, stdin), ..others]
    [] -> []
  }
}

// --- gh ---

/// Every title, body and comment that `gh pr` and `gh issue` commands send.
///
/// The commands are `create`, `edit` and `comment`, and `review` for `gh pr`.
/// A flag value counts only when it reads as prose, so `gh pr list -b main` and
/// `--body "$BODY"` stay unread.
pub fn gh_texts(source: String) -> List(GhText) {
  list.flat_map(commands(source), command_texts)
}

/// The same list as JSON, so no host depends on the shape of a Gleam record.
pub fn gh_texts_json(source: String) -> String {
  gh_texts(source)
  |> json.array(fn(found) {
    json.object([
      #("label", json.string(found.label)),
      #("text", json.string(found.text)),
      #("file", json.nullable(found.file, json.string)),
    ])
  })
  |> json.to_string
}

fn command_texts(command: Command) -> List(GhText) {
  case list.drop_while(command.words, is_assignment) {
    [program, noun, verb, ..args] ->
      case is_gh(program.value), target(noun.value, verb.value, command.stdin) {
        True, Ok(found) -> flag_loop(args, found, [])
        _, _ -> []
      }
    _ -> []
  }
}

fn is_assignment(word: Word) -> Bool {
  matches("^\\w+=", word.value)
}

fn is_gh(program: String) -> Bool {
  program == "gh" || string.ends_with(program, "/gh")
}

/// What `noun verb` calls its fields. A body means a comment on `comment`, and
/// a review on `review`, so a block reason names the right thing.
fn target(noun: String, verb: String, stdin: String) -> Result(Target, Nil) {
  case noun, verb {
    "pr", "create" | "pr", "edit" -> Ok(Target("PR", "body", stdin))
    "pr", "comment" -> Ok(Target("PR", "comment", stdin))
    "pr", "review" -> Ok(Target("PR", "review", stdin))
    "issue", "create" | "issue", "edit" -> Ok(Target("issue", "body", stdin))
    "issue", "comment" -> Ok(Target("issue", "comment", stdin))
    _, _ -> Error(Nil)
  }
}

fn flag_loop(
  args: List(Word),
  target: Target,
  found: List(GhText),
) -> List(GhText) {
  case args {
    [] -> list.reverse(found)
    [word, ..rest] ->
      case flag_of(word) {
        None -> flag_loop(rest, target, found)
        Some(Flag(field, inline)) -> {
          let #(value, after) = take_value(inline, rest)
          let texts = field_texts(field, value, target)
          flag_loop(after, target, list.append(list.reverse(texts), found))
        }
      }
  }
}

/// The value of a flag. It is the text after `=`, or else the next word.
fn take_value(
  inline: Option(String),
  rest: List(Word),
) -> #(Option(Word), List(Word)) {
  case inline, rest {
    Some(text), _ -> #(Some(Word(text, False, False)), rest)
    None, [next, ..after] -> #(Some(next), after)
    None, [] -> #(None, [])
  }
}

fn flag_of(word: Word) -> Option(Flag) {
  case word.dynamic, scan(flag_pattern, word.value) {
    False, Ok(match) -> {
      let long = option.from_result(submatch(match, 0))
      let short = option.from_result(submatch(match, 2))
      case long, short {
        Some(field), _ ->
          Some(Flag(field, option.from_result(submatch(match, 1))))
        None, Some(letter) ->
          Some(Flag(short_field(letter), option.from_result(submatch(match, 3))))
        None, None -> None
      }
    }
    _, _ -> None
  }
}

fn short_field(letter: String) -> String {
  case letter {
    "t" -> "title"
    "b" -> "body"
    _ -> "body-file"
  }
}

fn field_texts(
  field: String,
  value: Option(Word),
  target: Target,
) -> List(GhText) {
  case value {
    Some(Word(text, False, from_heredoc)) ->
      case field {
        "title" -> prose_text(text, False, label(target, "title"))
        "body" -> prose_text(text, from_heredoc, label(target, target.body))
        _ -> file_text(text, target)
      }
    _ -> []
  }
}

fn prose_text(text: String, trusted: Bool, label: String) -> List(GhText) {
  case trusted || reads_as_prose(text) {
    True -> [GhText(label, text, None)]
    False -> []
  }
}

fn file_text(path: String, target: Target) -> List(GhText) {
  let label = label(target, target.body)
  case path {
    "-" ->
      case string.trim(target.stdin) {
        "" -> []
        _ -> [GhText(label, target.stdin, None)]
      }
    _ -> [GhText(label <> " (" <> base_name(path) <> ")", "", Some(path))]
  }
}

fn label(target: Target, field: String) -> String {
  "the " <> target.noun <> " " <> field
}

fn base_name(path: String) -> String {
  string.split(path, "/")
  |> list.last
  |> result.unwrap(path)
}

/// True when a value reads as prose rather than as a token.
///
/// A value needs two words with a letter in them, and one lowercase letter.
/// So `main`, `755` and `$BODY` stay unread.
fn reads_as_prose(value: String) -> Bool {
  let words =
    regexp.split(compile("\\s+"), string.trim(value))
    |> list.filter(matches("[a-zA-Z]", _))
  list.length(words) >= 2 && matches("[a-z]", value)
}

// --- regexp helpers ---

fn compile(pattern: String) -> regexp.Regexp {
  let assert Ok(compiled) = regexp.from_string(pattern)
  compiled
}

fn matches(pattern: String, text: String) -> Bool {
  regexp.check(compile(pattern), text)
}

fn scan(pattern: String, text: String) -> Result(Match, Nil) {
  case regexp.scan(compile(pattern), text) {
    [match, ..] -> Ok(match)
    [] -> Error(Nil)
  }
}

fn submatch(match: Match, index: Int) -> Result(String, Nil) {
  case list.drop(match.submatches, index) {
    [Some(text), ..] -> Ok(text)
    _ -> Error(Nil)
  }
}

fn group(match: Match, index: Int) -> String {
  result.unwrap(submatch(match, index), "")
}
