import gleam/json.{type Json}
import gleam/list

/// Every rule the engine can report. A new variant here makes the compiler ask
/// for its name, its severity and its prompt line.
pub type Id {
  NotApprovedWord
  SentenceLength
  ParagraphLength
  Progressive
  Perfect
  Passive
  Contraction
  Semicolon
  PhrasalVerb
  Hedge
  Marketing
  InvalidDirective
}

pub type Severity {
  /// The check is deterministic. The host may block the write.
  Hard
  /// The check is a heuristic. The host must only warn.
  Soft
}

pub type Violation {
  Violation(
    rule_id: Id,
    message: String,
    line: Int,
    column: Int,
    severity: Severity,
  )
}

/// The roster. A test proves that every rule here can fire.
pub fn all() -> List(Id) {
  [
    NotApprovedWord,
    SentenceLength,
    ParagraphLength,
    Progressive,
    Perfect,
    Passive,
    Contraction,
    Semicolon,
    PhrasalVerb,
    Hedge,
    Marketing,
    InvalidDirective,
  ]
}

/// Reads a rule id back from its name. A suppression comment names a rule. A
/// name the roster does not hold is a fault, and the reader must see it.
pub fn from_string(name: String) -> Result(Id, Nil) {
  all()
  |> list.find(fn(id) { to_string(id) == name })
}

/// The name the host, the CLI and the prompt all report.
pub fn to_string(id: Id) -> String {
  case id {
    NotApprovedWord -> "dictionary/not-approved-word"
    SentenceLength -> "length/sentence"
    ParagraphLength -> "length/paragraph"
    Progressive -> "verb/progressive"
    Perfect -> "verb/perfect"
    Passive -> "verb/passive"
    Contraction -> "style/contraction"
    Semicolon -> "style/semicolon"
    PhrasalVerb -> "style/phrasal-verb"
    Hedge -> "style/hedge"
    Marketing -> "style/marketing"
    InvalidDirective -> "suppress/invalid-directive"
  }
}

/// The severity a rule reports. Two sites narrow this to Soft: a sentence
/// between the two length limits, and a not-approved word inside a hyphen.
pub fn severity(id: Id) -> Severity {
  case id {
    NotApprovedWord -> Hard
    SentenceLength -> Hard
    ParagraphLength -> Hard
    Progressive -> Hard
    Perfect -> Hard
    Passive -> Soft
    Contraction -> Hard
    Semicolon -> Hard
    PhrasalVerb -> Hard
    Hedge -> Soft
    Marketing -> Soft
    InvalidDirective -> Hard
  }
}

/// The rule as the system prompt states it.
fn prompt(id: Id) -> String {
  case id {
    NotApprovedWord -> "Use one word for one meaning. Prefer the approved word."
    SentenceLength ->
      "Write no more than 20 words in an instruction sentence, and no more than 25 in a descriptive sentence."
    ParagraphLength ->
      "Write no more than 6 sentences in an instruction paragraph, and no more than 3 in a descriptive paragraph."
    Progressive -> "Use the simple tenses only. Do not write \"is removing\"."
    Perfect ->
      "Do not use the perfect tenses. Write \"we received\", not \"we have received\"."
    Passive ->
      "Use the active voice for an instruction. Passive voice is allowed in descriptive text only when the actor is unknown."
    Contraction -> "Do not use a contraction. Write \"do not\", not \"don't\"."
    Semicolon -> "Do not use a semicolon. Write two sentences."
    PhrasalVerb ->
      "Do not use a phrasal verb. Write \"start\", not \"spin up\"."
    Hedge -> "Do not hedge. Delete \"it is important to note\"."
    Marketing ->
      "Do not use a marketing adjective such as \"seamless\" or \"robust\"."
    InvalidDirective ->
      "A \"ste-disable-next-line\" comment must name at least one real rule id."
  }
}

pub fn to_prompt_line(id: Id) -> String {
  "- " <> prompt(id) <> " (" <> to_string(id) <> ")"
}

pub fn violation_to_json(violation: Violation) -> Json {
  json.object([
    #("ruleId", json.string(to_string(violation.rule_id))),
    #("message", json.string(violation.message)),
    #("line", json.int(violation.line)),
    #("column", json.int(violation.column)),
    #("severity", json.string(severity_to_string(violation.severity))),
  ])
}

fn severity_to_string(value: Severity) -> String {
  case value {
    Hard -> "hard"
    Soft -> "soft"
  }
}
