import gleam/list
import gleam/pair
import gleam/string

/// One source line, with its 1-based number.
pub type Line {
  Line(text: String, number: Int)
}

/// Splits text into numbered lines.
pub fn lines(text: String) -> List(Line) {
  string.split(text, on: "\n")
  |> list.index_map(fn(text, index) { Line(text: text, number: index + 1) })
}

/// Replaces code with spaces and keeps every line and column intact. It blanks
/// a character and never deletes one, so every later line number stays the
/// same.
///
/// Adapted from Ryuketsukami/ste-plain-writing (MIT).
pub fn mask(text: String) -> String {
  string.split(text, on: "\n")
  |> list.map_fold(from: False, with: mask_line)
  |> pair.second
  |> string.join(with: "\n")
}

/// Threads the fence flag, so a fenced block masks every line inside it.
fn mask_line(in_fence: Bool, line: String) -> #(Bool, String) {
  case is_fence(line), in_fence {
    True, _ -> #(!in_fence, blank(line))
    False, True -> #(True, blank(line))
    False, False -> #(False, mask_inline(line))
  }
}

fn is_fence(line: String) -> Bool {
  let trimmed = string.trim_start(line)
  string.starts_with(trimmed, "```") || string.starts_with(trimmed, "~~~")
}

fn blank(line: String) -> String {
  string.repeat(" ", string.length(line))
}

/// Blanks every `inline span` and keeps the line length unchanged.
fn mask_inline(line: String) -> String {
  string.to_graphemes(line)
  |> list.map_fold(from: False, with: mask_grapheme)
  |> pair.second
  |> string.join(with: "")
}

fn mask_grapheme(inside: Bool, grapheme: String) -> #(Bool, String) {
  case grapheme, inside {
    "`", _ -> #(!inside, " ")
    _, True -> #(True, " ")
    _, False -> #(False, grapheme)
  }
}
