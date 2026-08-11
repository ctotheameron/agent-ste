import gleam/json
import gleam/list
import gleam/result
import gleam/string
import ste/checks.{type Patterns}
import ste/dictionary.{type Table}
import ste/rule.{type Violation}
import ste/segment.{type Splitter}
import ste/source.{type Line}
import ste/suppress
import ste/token.{type Lexer}

pub type Engine {
  Engine(table: Table, lexer: Lexer, patterns: Patterns, splitter: Splitter)
}

/// Build this once, then pass it to every lint call. The dictionary and every
/// regexp compile here once, so a caller reuses them for every line.
pub fn new_engine() -> Result(Engine, Nil) {
  use lexer <- result.try(token.lexer())
  use patterns <- result.try(checks.patterns())
  use splitter <- result.try(segment.splitter())
  Ok(Engine(
    table: dictionary.table(),
    lexer: lexer,
    patterns: patterns,
    splitter: splitter,
  ))
}

/// The JavaScript boundary. It returns JSON so the host never depends on
/// Gleam's internal representation of a List or a custom type. The host holds
/// the opaque `Engine` value and passes it straight back.
pub fn lint_json_with(engine: Engine, text: String) -> String {
  lint_with(engine, text)
  |> json.array(rule.violation_to_json)
  |> json.to_string
}

pub fn lint_with(engine: Engine, text: String) -> List(Violation) {
  let masked = source.mask(text)
  let directives = suppress.directives(source.lines(masked))

  list.flatten([
    line_violations(engine, masked),
    sentence_violations(engine, masked),
    paragraph_violations(engine, masked),
  ])
  |> suppress.apply(directives)
  |> list.append(suppress.faults(directives))
}

fn line_violations(engine: Engine, masked: String) -> List(Violation) {
  source.lines(masked)
  |> list.flat_map(line_checks(engine, _))
}

fn line_checks(engine: Engine, line: Line) -> List(Violation) {
  let tokens = token.tokenize(engine.lexer, line.text)
  list.flatten([
    dictionary.check(engine.table, tokens, on: line),
    checks.semicolon(line),
    checks.verb_forms(engine.patterns, line),
  ])
}

fn sentence_violations(engine: Engine, masked: String) -> List(Violation) {
  segment.sentences(engine.splitter, masked)
  |> list.flat_map(checks.sentence_length)
}

fn paragraph_violations(engine: Engine, masked: String) -> List(Violation) {
  segment.paragraphs(engine.splitter, masked)
  |> list.flat_map(checks.paragraph_length)
}

/// Convenience for a one-shot call. It rebuilds the engine, so a caller in a
/// loop must use `new_engine` plus `lint_with` instead.
pub fn lint(text: String) -> List(Violation) {
  new_engine()
  |> result.map(lint_with(_, text))
  |> result.unwrap(or: [])
}

pub fn lint_json(text: String) -> String {
  new_engine()
  |> result.map(lint_json_with(_, text))
  |> result.unwrap(or: "[]")
}

/// The system-prompt text, derived from the same table the linter checks. One
/// source of truth means the prompt cannot ask for an unenforced rule. `/ste
/// off` removes both layers at once.
pub fn prompt_text() -> String {
  [
    "## Language: Simplified Technical English (ASD-STE100)",
    "",
    "Write every reply, comment, document, UI string and commit message in",
    "Simplified Technical English.",
    "",
    "### Rules",
    "",
    rule.all() |> list.map(rule.to_prompt_line) |> string.join(with: "\n"),
    "",
    "### Word choice",
    "",
    "Prefer the word on the left. A write is blocked when the text holds a",
    "word on the right.",
    "",
    word_table() |> string.join(with: "\n"),
    "",
    "### Exceptions",
    "",
    "- Do not rewrite quoted text, tool output, or a file you only read.",
    "- Keep identifiers, code and command syntax exactly as they are.",
    "- A technical name keeps its normal form: TypeScript, Prisma, GraphQL.",
    "- Put correctness first when a rule would make the text wrong.",
  ]
  |> string.join(with: "\n")
}

fn word_table() -> List(String) {
  dictionary.entries()
  |> list.filter(fn(entry) { entry.approved != "" })
  |> list.filter_map(word_line)
}

fn word_line(entry: dictionary.Entry) -> Result(String, Nil) {
  entry.forms
  |> list.first
  |> result.map(fn(head) { "- " <> entry.approved <> " — not " <> head })
}

/// Every rule id the engine can emit. A test compares this against
/// `rule.all()`, so the prompt can never promise an unenforced rule.
pub fn implemented_rule_ids() -> List(String) {
  probe_text()
  |> lint
  |> list.map(fn(violation) { rule.to_string(violation.rule_id) })
  |> list.unique
  |> list.sort(string.compare)
}

/// Text that breaks every rule at once, so the report names every id.
fn probe_text() -> String {
  [
    "We will initiate the change; it is being written.",
    "We have received the file and it isn't complete.",
    "The record was created. Please note that this is a seamless turnkey"
      <> " enterprise data pipeline stream handler.",
    "Spin up the worker prior to the merge, and then wait for a long"
      <> " sentence that runs past the descriptive limit of twenty five"
      <> " words in total length.",
    "One. Two. Three. Four. Five. Six. Seven. Eight.",
    // This covers the line after itself, and no line follows it. So it silences
    // nothing, and its bad name reports.
    "<!-- ste-disable-next-line no-such-rule -->",
  ]
  |> string.join(with: "\n")
}
