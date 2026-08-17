//// Decides which text in a file the linter may read.
////
//// A rule about which text counts is a rule. So it belongs beside the other
//// rules rather than in a host. Every function here returns a string of the
//// same line count as its input, and blanks the rest. A host then reports a
//// line number that matches the real file, with no offset arithmetic.

import gleam/int
import gleam/list
import gleam/pair
import gleam/result
import gleam/string

/// What the linter may read in a file.
type Kind {
  /// The whole file, minus code fences and code spans.
  Prose
  /// A `//` comment, and the inside of a `/* */` block.
  Slash
  /// A `#` comment.
  Hash
  /// Nothing at all.
  Opaque
}

const prose_extensions = [".md", ".mdx", ".markdown", ".txt", ".rst"]

const slash_extensions = [
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".gleam", ".go", ".rs", ".swift",
  ".kt", ".java", ".c", ".h", ".cpp",
]

const hash_extensions = [
  ".sh", ".bash", ".zsh", ".py", ".rb", ".yml", ".yaml", ".toml", ".just",
]

/// The lintable view of a file. An empty string means the file holds no prose.
pub fn lintable_text(path: String, content: String) -> String {
  case kind_of(extension_of(path)) {
    Prose -> content
    Slash -> merge(comments_only(content, "//"), block_comments(content))
    Hash -> comments_only(content, "#")
    Opaque -> ""
  }
}

fn kind_of(extension: String) -> Kind {
  case extension {
    _ if extension == "" -> Opaque
    _ ->
      case
        list.contains(prose_extensions, extension),
        list.contains(slash_extensions, extension),
        list.contains(hash_extensions, extension)
      {
        True, _, _ -> Prose
        _, True, _ -> Slash
        _, _, True -> Hash
        _, _, _ -> Opaque
      }
  }
}

/// The extension of a path, in lowercase, with its dot.
///
/// A name that opens with a dot carries no extension. `.bashrc` names a shell
/// file, and the text before the dot is empty, so the file stays opaque.
fn extension_of(path: String) -> String {
  let base =
    path
    |> string.split(on: "/")
    |> list.last
    |> result.unwrap(or: path)

  case string.split(base, on: ".") {
    [] | [_] -> ""
    [first, ..rest] ->
      case first == "" && list.length(rest) == 1 {
        True -> ""
        False -> {
          let last = rest |> list.last |> result.unwrap(or: "")
          string.lowercase("." <> last)
        }
      }
  }
}

fn blank(text: String) -> String {
  string.repeat(" ", string.length(text))
}

/// The marker a file uses, and whether a template literal can span a line.
type Reader {
  Reader(marker: String, tracks_template: Bool)
}

/// Keeps a `//` or `#` comment body, and blanks the rest.
///
/// A template literal spans lines, and its text often holds a URL or a word the
/// rules ban. So a backtick count tracks that state across lines. A quote on
/// one line uses a count as well, which is crude, and which needs no parser.
fn comments_only(content: String, marker: String) -> String {
  let reader = Reader(marker: marker, tracks_template: marker == "//")

  string.split(content, on: "\n")
  |> list.map_fold(from: False, with: read_line(reader))
  |> pair.second
  |> string.join(with: "\n")
}

fn read_line(reader: Reader) {
  fn(in_template: Bool, line: String) -> #(Bool, String) {
    let flips = reader.tracks_template && int.is_odd(count_unescaped(line, "`"))

    case in_template {
      True -> #(!flips, blank(line))
      False -> #(!flips, take_comment(reader.marker, line))
    }
  }
}

fn take_comment(marker: String, line: String) -> String {
  case marker_at(line, marker, 0) {
    Error(_) -> blank(line)
    Ok(at) -> keep_after(marker, line, at)
  }
}

fn keep_after(marker: String, line: String, at: Int) -> String {
  let before = string.slice(line, at_index: 0, length: at)
  // A marker inside a string literal starts no comment. A count of the quotes
  // in front of it is crude, and it needs no parser.
  case int.is_odd(quotes_in(before)) {
    True -> blank(line)
    False ->
      blank(before)
      <> blank(marker)
      <> string.drop_start(line, at + string.length(marker))
  }
}

/// The index of a real marker, or an error when the line holds none.
///
/// `https://example.com` holds `//` and starts no comment. A colon in front of
/// the marker names a scheme, so the search moves past it and tries again.
fn marker_at(line: String, marker: String, from: Int) -> Result(Int, Nil) {
  let rest = string.drop_start(line, from)
  use #(before, _) <- result.try(string.split_once(rest, on: marker))
  let at = from + string.length(before)

  case at > 0 && string.slice(line, at_index: at - 1, length: 1) == ":" {
    True -> marker_at(line, marker, at + string.length(marker))
    False -> Ok(at)
  }
}

fn quotes_in(text: String) -> Int {
  ["\"", "'", "`"]
  |> list.map(count_unescaped(text, _))
  |> int.sum
}

/// The count of a character that no backslash escapes.
///
/// A split counts every occurrence, and a second split counts the escaped ones.
/// The difference needs no lookbehind, which keeps the pattern portable.
fn count_unescaped(text: String, character: String) -> Int {
  occurrences(text, character) - occurrences(text, "\\" <> character)
}

fn occurrences(text: String, needle: String) -> Int {
  list.length(string.split(text, on: needle)) - 1
}

/// Keeps the inside of a block comment, and blanks the rest.
fn block_comments(content: String) -> String {
  string.split(content, on: "\n")
  |> list.map_fold(from: False, with: read_block_line)
  |> pair.second
  |> string.join(with: "\n")
}

fn read_block_line(inside: Bool, line: String) -> #(Bool, String) {
  let closes = string.contains(line, "*/")

  case inside || opens_block(line) {
    False -> #(False, blank(line))
    True -> #(!closes, blank_markers(line))
  }
}

/// True when a line opens a block comment outside a string and outside a
/// comment.
///
/// Two tests keep it shut. A `/*` after a `//` sits inside that line comment,
/// and a doc comment that names the marker is prose. A `/*` inside a string is
/// data, such as the `".git/*"` of a real ignore list.
fn opens_block(line: String) -> Bool {
  case string.split_once(line, on: "/*") {
    Error(_) -> False
    Ok(#(before, _)) ->
      !string.contains(before, "//") && !int.is_odd(quotes_in(before))
  }
}

/// Blanks a block marker and a leading star, and keeps every column.
fn blank_markers(line: String) -> String {
  line
  |> string.replace(each: "/*", with: "  ")
  |> string.replace(each: "*/", with: "  ")
  |> blank_leading_star
}

fn blank_leading_star(line: String) -> String {
  let trimmed = string.trim_start(line)
  let indent = string.length(line) - string.length(trimmed)

  case string.starts_with(trimmed, "*") {
    False -> line
    True -> string.repeat(" ", indent + 1) <> string.drop_start(trimmed, 1)
  }
}

/// Joins two masks. A character wins over a space at the same column.
fn merge(left: String, right: String) -> String {
  let other = string.split(right, on: "\n")

  string.split(left, on: "\n")
  |> list.index_map(fn(line, index) {
    let mate = other |> list.drop(index) |> list.first |> result.unwrap(or: "")
    merge_line(line, mate)
  })
  |> string.join(with: "\n")
}

fn merge_line(line: String, mate: String) -> String {
  let mate_graphemes = string.to_graphemes(mate)

  string.to_graphemes(line)
  |> list.index_map(fn(character, column) {
    case character {
      " " ->
        mate_graphemes
        |> list.drop(column)
        |> list.first
        |> result.unwrap(or: " ")
      _ -> character
    }
  })
  |> string.join(with: "")
}
