import gleam/json.{type Json}
import gleam/list

pub type Severity {
  /// The check is deterministic. The host may block the write.
  Hard
  /// The check is a heuristic. The host must only warn.
  Soft
}

pub type Violation {
  Violation(
    rule_id: String,
    message: String,
    line: Int,
    column: Int,
    severity: Severity,
  )
}

pub fn violation_to_json(violation: Violation) -> Json {
  json.object([
    #("ruleId", json.string(violation.rule_id)),
    #("message", json.string(violation.message)),
    #("line", json.int(violation.line)),
    #("column", json.int(violation.column)),
    #("severity", json.string(severity_to_string(violation.severity))),
  ])
}

fn severity_to_string(severity: Severity) -> String {
  case severity {
    Hard -> "hard"
    Soft -> "soft"
  }
}

pub type Rule {
  Rule(id: String, prompt_text: String, severity: Severity)
}

/// Every rule the engine knows. The system prompt uses this list, so a new rule
/// reaches the model and the linter together.
pub fn all() -> List(Rule) {
  [
    Rule(
      "dictionary/not-approved-word",
      "Use one word for one meaning. Prefer the approved word.",
      Hard,
    ),
    Rule(
      "length/sentence",
      "Write no more than 20 words in an instruction sentence, and no more than 25 in a descriptive sentence.",
      Hard,
    ),
    Rule(
      "length/paragraph",
      "Write no more than 6 sentences in an instruction paragraph, and no more than 3 in a descriptive paragraph.",
      Hard,
    ),
    Rule(
      "verb/progressive",
      "Use the simple tenses only. Do not write \"is removing\".",
      Hard,
    ),
    Rule(
      "verb/perfect",
      "Do not use the perfect tenses. Write \"we received\", not \"we have received\".",
      Hard,
    ),
    Rule(
      "verb/passive",
      "Use the active voice for an instruction. Passive voice is allowed in descriptive text only when the actor is unknown.",
      Soft,
    ),
    Rule(
      "style/contraction",
      "Do not use a contraction. Write \"do not\", not \"don't\".",
      Hard,
    ),
    Rule(
      "style/semicolon",
      "Do not use a semicolon. Write two sentences.",
      Hard,
    ),
    Rule(
      "style/phrasal-verb",
      "Do not use a phrasal verb. Write \"start\", not \"spin up\".",
      Hard,
    ),
    Rule(
      "style/hedge",
      "Do not hedge. Delete \"it is important to note\".",
      Soft,
    ),
    Rule(
      "style/marketing",
      "Do not use a marketing adjective such as \"seamless\" or \"robust\".",
      Soft,
    ),
  ]
}

pub fn to_prompt_line(rule: Rule) -> String {
  "- " <> rule.prompt_text <> " (" <> rule.id <> ")"
}

pub fn hard_rule_ids() -> List(String) {
  all()
  |> list.filter(fn(rule) { rule.severity == Hard })
  |> list.map(fn(rule) { rule.id })
}
