import gleam/json
import gleam/list
import gleam/string
import ste/checks.{type Patterns}
import ste/dictionary.{type Table}
import ste/rule.{type Violation}
import ste/segment.{type Splitter}
import ste/source
import ste/token.{type Lexer}

pub type Engine {
  Engine(table: Table, lexer: Lexer, patterns: Patterns, splitter: Splitter)
}

/// Build this once, then pass it to every lint call. The dictionary and every
/// regexp compile here once, so a caller reuses them for every line.
pub fn new_engine() -> Result(Engine, Nil) {
  case token.lexer(), checks.patterns(), segment.splitter() {
    Ok(lexer), Ok(patterns), Ok(splitter) ->
      Ok(Engine(
        table: dictionary.table(),
        lexer: lexer,
        patterns: patterns,
        splitter: splitter,
      ))
    _, _, _ -> Error(Nil)
  }
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
  list.flatten([
    line_violations(engine, masked),
    sentence_violations(engine, masked),
    paragraph_violations(engine, masked),
  ])
}

fn line_violations(engine: Engine, masked: String) -> List(Violation) {
  string.split(masked, on: "\n")
  |> list.index_map(fn(line, index) {
    let line_number = index + 1
    list.flatten([
      dictionary.check(
        engine.table,
        token.tokenize(engine.lexer, line),
        line_number,
      ),
      checks.semicolon(line, line_number),
      checks.verb_forms(engine.patterns, line, line_number),
    ])
  })
  |> list.flatten
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
  case new_engine() {
    Ok(engine) -> lint_with(engine, text)
    Error(_) -> []
  }
}

pub fn lint_json(text: String) -> String {
  case new_engine() {
    Ok(engine) -> lint_json_with(engine, text)
    Error(_) -> "[]"
  }
}

/// The system-prompt text, derived from the same table the linter checks. One
/// source of truth means the prompt cannot ask for an unenforced rule. `/ste
/// off` removes both layers at once.
pub fn prompt_text() -> String {
  string.join(
    [
      "## Language: Simplified Technical English (ASD-STE100)",
      "",
      "Write every reply, comment, document, UI string and commit message in",
      "Simplified Technical English.",
      "",
      "### Rules",
      "",
      string.join(list.map(rule.all(), rule.to_prompt_line), "\n"),
      "",
      "### Word choice",
      "",
      "Prefer the word on the left. A write is blocked when the text holds a",
      "word on the right.",
      "",
      string.join(word_table(), "\n"),
      "",
      "### Exceptions",
      "",
      "- Do not rewrite quoted text, tool output, or a file you only read.",
      "- Keep identifiers, code and command syntax exactly as they are.",
      "- A technical name keeps its normal form: TypeScript, Prisma, GraphQL.",
      "- Put correctness first when a rule would make the text wrong.",
    ],
    "\n",
  )
}

fn word_table() -> List(String) {
  dictionary.entries()
  |> list.filter(fn(entry) { entry.approved != "" })
  |> list.filter_map(fn(entry) {
    case entry.forms {
      [head, ..] -> Ok("- " <> entry.approved <> " — not " <> head)
      [] -> Error(Nil)
    }
  })
}

/// Every rule id the engine can emit. A test compares this against
/// `rule.all()`, so the prompt can never promise an unenforced rule.
pub fn implemented_rule_ids() -> List(String) {
  let probe =
    string.join(
      [
        "We will initiate the change; it is being written.",
        "We have received the file and it isn't complete.",
        "The record was created. Please note that this is a seamless turnkey"
          <> " enterprise data pipeline stream handler.",
        "Spin up the worker prior to the merge, and then wait for a long"
          <> " sentence that runs past the descriptive limit of twenty five"
          <> " words in total length.",
        "One. Two. Three. Four. Five. Six. Seven. Eight.",
      ],
      "\n",
    )
  lint(probe)
  |> list.map(fn(violation) { violation.rule_id })
  |> list.unique
  |> list.sort(string.compare)
}
