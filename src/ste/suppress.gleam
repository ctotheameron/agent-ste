//// Reads a `ste-disable-next-line` comment and silences the rules it names.
////
//// A hard rule blocks a write, so a false report stops real work. This gives
//// the author a way out that costs one line and names the rule it silences.
//// The comment covers the next line only, so it cannot silence a whole file.
////
//// The engine reads one form in every file type. The host reduces a source
//// file to its comment bodies, so `// ste-disable-next-line style/marketing`
//// and `<!-- ste-disable-next-line style/marketing -->` both arrive as text
//// with the marker inside.

import gleam/list
import gleam/result
import gleam/string
import ste/rule.{type Id, type Violation, Violation}
import ste/source.{type Line}

const marker = "ste-disable-next-line"

/// One comment, and the line below it that the comment covers.
pub opaque type Directive {
  Directive(
    covers: Int,
    line: Int,
    column: Int,
    ids: List(Id),
    unknown: List(String),
  )
}

/// Every directive in the text, in the order it appears.
pub fn directives(lines: List(Line)) -> List(Directive) {
  lines
  |> list.filter_map(read)
}

fn read(line: Line) -> Result(Directive, Nil) {
  use #(before, tail) <- result.try(string.split_once(line.text, on: marker))
  let names = names_in(tail)
  Ok(Directive(
    covers: line.number + 1,
    line: line.number,
    column: string.length(before) + 1,
    ids: list.filter_map(names, rule.from_string),
    unknown: list.filter(names, fn(name) { is_unknown(name) }),
  ))
}

fn is_unknown(name: String) -> Bool {
  rule.from_string(name)
  |> result.is_error
}

/// The names after the marker. A comma and a space both separate two names, and
/// a comment ending such as `-->` or `*/` is not a name.
fn names_in(tail: String) -> List(String) {
  ["-->", "*/", ",", "\t"]
  |> list.fold(from: tail, with: fn(text, part) {
    string.replace(text, each: part, with: " ")
  })
  |> string.split(on: " ")
  |> list.filter(fn(name) { name != "" })
}

/// Drops every violation that a directive silences.
pub fn apply(
  violations: List(Violation),
  directives: List(Directive),
) -> List(Violation) {
  list.filter(violations, fn(violation) { !is_silent(violation, directives) })
}

fn is_silent(violation: Violation, directives: List(Directive)) -> Bool {
  list.any(directives, fn(directive) {
    directive.covers == violation.line
    && list.contains(directive.ids, violation.rule_id)
  })
}

/// A report for each directive that silences nothing.
///
/// A comment with a typo in it reads as working and does nothing. So a name the
/// roster does not hold, and a comment with no name at all, both report.
pub fn faults(directives: List(Directive)) -> List(Violation) {
  directives
  |> list.filter_map(fault)
}

fn fault(directive: Directive) -> Result(Violation, Nil) {
  use message <- result.try(reason(directive))
  Ok(Violation(
    rule_id: rule.InvalidDirective,
    message: message,
    line: directive.line,
    column: directive.column,
    severity: rule.severity(rule.InvalidDirective),
  ))
}

fn reason(directive: Directive) -> Result(String, Nil) {
  case directive.unknown, directive.ids {
    [_, ..], _ ->
      Ok(
        "This comment names no such rule: "
        <> string.join(directive.unknown, with: ", ")
        <> ". Name a rule the engine reports.",
      )
    [], [] ->
      Ok(
        "This comment names no rule, so it silences nothing. Name at least one.",
      )
    [], [_, ..] -> Error(Nil)
  }
}
