import gleam/bool
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

/// What the mask knows when it reaches a line.
///
/// A mask needs the lines before the current one. A fence opens and closes.
/// Front matter opens on line 1 only. An indented code block opens after a
/// blank line, so the mask carries that fact forward.
type Scan {
  Scan(
    in_fence: Bool,
    in_front_matter: Bool,
    in_code: Bool,
    after_blank: Bool,
    at_start: Bool,
  )
}

fn start() -> Scan {
  Scan(
    in_fence: False,
    in_front_matter: False,
    in_code: False,
    after_blank: True,
    at_start: True,
  )
}

/// Replaces code with spaces and keeps every line and column intact. It blanks
/// a character and never deletes one, so every later line number stays the
/// same.
///
/// Four kinds of text hide from the rules. A fenced block and an inline span
/// hide, and so do YAML front matter and an indented code block. Each one holds
/// data or code, and none of them holds prose.
///
/// Adapted from Ryuketsukami/ste-plain-writing (MIT).
pub fn mask(text: String) -> String {
  string.split(text, on: "\n")
  |> list.map_fold(from: start(), with: mask_line)
  |> pair.second
  |> string.join(with: "\n")
}

/// Masks one line and reports what the next line inherits.
fn mask_line(scan: Scan, line: String) -> #(Scan, String) {
  let trimmed = string.trim(line)
  let next = Scan(..scan, at_start: False, after_blank: trimmed == "")

  case kind_of(scan, line, trimmed) {
    FrontMatterOpen -> #(Scan(..next, in_front_matter: True), blank(line))
    FrontMatterClose -> #(Scan(..next, in_front_matter: False), blank(line))
    FrontMatter -> #(next, blank(line))
    Fence -> #(Scan(..next, in_fence: !scan.in_fence), blank(line))
    Fenced -> #(next, blank(line))
    Indented -> #(Scan(..next, in_code: True), blank(line))
    // A blank line does not close an indented block. Code often holds one.
    BlankInCode -> #(next, line)
    Prose -> #(Scan(..next, in_code: False), mask_inline(line))
  }
}

type Kind {
  FrontMatterOpen
  FrontMatterClose
  FrontMatter
  Fence
  Fenced
  Indented
  BlankInCode
  Prose
}

/// Names one line, in the order the rules apply. A fence inside front matter is
/// still front matter, so front matter comes first.
fn kind_of(scan: Scan, line: String, trimmed: String) -> Kind {
  case scan.in_front_matter, scan.at_start && trimmed == "---" {
    True, _ -> front_matter_kind(trimmed)
    False, True -> FrontMatterOpen
    False, False -> body_kind(scan, line, trimmed)
  }
}

/// YAML ends the document with `---` or with `...`.
fn front_matter_kind(trimmed: String) -> Kind {
  case trimmed == "---" || trimmed == "..." {
    True -> FrontMatterClose
    False -> FrontMatter
  }
}

fn body_kind(scan: Scan, line: String, trimmed: String) -> Kind {
  case is_fence(trimmed), scan.in_fence {
    True, _ -> Fence
    False, True -> Fenced
    False, False -> text_kind(scan, line, trimmed)
  }
}

fn text_kind(scan: Scan, line: String, trimmed: String) -> Kind {
  use <- bool.guard(when: trimmed == "" && scan.in_code, return: BlankInCode)
  case is_indented_code(scan, line, trimmed) {
    True -> Indented
    False -> Prose
  }
}

fn is_fence(trimmed: String) -> Bool {
  string.starts_with(trimmed, "```") || string.starts_with(trimmed, "~~~")
}

/// An indented code block opens after a blank line and stays open while the
/// indent holds. A list marker keeps its line as prose, because a nested list
/// carries the same indent as a code block.
fn is_indented_code(scan: Scan, line: String, trimmed: String) -> Bool {
  // `||` binds looser than `|>`, so a pipeline here reads as one wrong
  // expression and blanks every line after a blank one. Name the parts.
  let opens = scan.after_blank || scan.in_code
  opens && indent(line) >= 4 && !starts_a_list(trimmed)
}

fn indent(line: String) -> Int {
  let tabs_widened = string.replace(line, each: "\t", with: "    ")
  string.length(tabs_widened) - string.length(string.trim_start(tabs_widened))
}

/// The markers CommonMark gives a bullet list. A number list needs a digit, so
/// this checks the first two characters of an ordered marker as well.
fn starts_a_list(trimmed: String) -> Bool {
  ["- ", "* ", "+ ", "1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.", "0."]
  |> list.any(string.starts_with(trimmed, _))
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
