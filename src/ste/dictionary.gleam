import gleam/bool
import gleam/dict.{type Dict}
import gleam/int
import gleam/list
import gleam/pair
import gleam/result
import gleam/set.{type Set}
import gleam/string
import ste/rule.{type Id, type Severity, type Violation, Soft, Violation}
import ste/source.{type Line}
import ste/token.{type Token}

pub type Entry {
  /// `forms` lists every spelling to flag. An explicit list beats a suffix
  /// regexp: `\bprior\w*` also matches "priority", and an English verb stem
  /// drops its "e" before "-ing".
  Entry(forms: List(String), approved: String, id: Id)
}

pub type Replacement {
  Replacement(approved: String, id: Id, severity: Severity)
}

/// One dictionary hit. `size` counts the tokens it consumed. `offset` is 0 for
/// a whole token, and points inside the token for a hyphen part.
type Match {
  Match(found: String, replacement: Replacement, size: Int, offset: Int)
}

pub type Table {
  /// `phrase_starts` holds the first word of every multi-word entry. Most
  /// tokens start no phrase, so the common path costs one Dict lookup instead
  /// of one lookup per n-gram size.
  Table(
    replacements: Dict(String, Replacement),
    phrase_starts: Set(String),
    max_words: Int,
  )
}

/// The table and the line together, so a step passes one value, not two.
type Search {
  Search(table: Table, line: Line)
}

/// Build this ONCE and reuse it. Gleam has no module-level mutable state and a
/// `const` cannot hold a Dict, so the host owns the value.
pub fn table() -> Table {
  let forms = entries() |> list.flat_map(entry_forms)
  let phrases = forms |> list.filter(fn(form) { phrase_length(form.0) > 1 })

  Table(
    replacements: dict.from_list(forms),
    phrase_starts: phrases
      |> list.filter_map(fn(form) { first_word(form.0) })
      |> set.from_list,
    max_words: phrases
      |> list.map(fn(form) { phrase_length(form.0) })
      |> list.fold(1, int.max),
  )
}

/// Every spelling of one entry, paired with the replacement to report.
fn entry_forms(entry: Entry) -> List(#(String, Replacement)) {
  let replacement =
    Replacement(
      approved: entry.approved,
      id: entry.id,
      severity: rule.severity(entry.id),
    )
  entry.forms
  |> list.map(fn(form) { #(form, replacement) })
}

fn first_word(phrase: String) -> Result(String, Nil) {
  string.split(phrase, on: " ")
  |> list.first
}

fn phrase_length(phrase: String) -> Int {
  string.split(phrase, on: " ")
  |> list.length
}

pub fn check(
  table: Table,
  tokens: List(Token),
  on line: Line,
) -> List(Violation) {
  check_loop(Search(table: table, line: line), tokens, [])
}

/// Greedy longest match. `prior to` must consume both tokens, or the entry for
/// `prior` reports the same span again.
fn check_loop(
  search: Search,
  tokens: List(Token),
  found: List(Violation),
) -> List(Violation) {
  case tokens {
    [] -> list.reverse(found)
    [head, ..rest] ->
      case longest_match(search.table, tokens) {
        Error(_) -> check_loop(search, rest, found)
        Ok(match) ->
          check_loop(search, list.drop(tokens, match.size), [
            to_violation(search.line, head, match),
            ..found
          ])
      }
  }
}

fn to_violation(line: Line, head: Token, match: Match) -> Violation {
  Violation(
    rule_id: match.replacement.id,
    message: message_for(match.replacement, match.found),
    line: line.number,
    column: head.column + match.offset,
    severity: match.replacement.severity,
  )
}

fn message_for(replacement: Replacement, found: String) -> String {
  case replacement.approved {
    "" -> "Delete \"" <> found <> "\"."
    approved -> "Use \"" <> approved <> "\", not \"" <> found <> "\"."
  }
}

fn longest_match(table: Table, tokens: List(Token)) -> Result(Match, Nil) {
  use head <- result.try(list.first(tokens))
  case set.contains(table.phrase_starts, head.lower) {
    True -> phrase_match(table, tokens, table.max_words)
    False -> word_match(table, head)
  }
}

/// The hot path: one lookup, and a hyphen part only when that lookup misses.
fn word_match(table: Table, head: Token) -> Result(Match, Nil) {
  dict.get(table.replacements, head.lower)
  |> result.map(fn(replacement) { Match(head.lower, replacement, 1, 0) })
  |> result.lazy_or(fn() { part_match(table, head) })
}

/// Tries the longest n-gram first, so `prior to` beats `prior`.
fn phrase_match(
  table: Table,
  tokens: List(Token),
  size: Int,
) -> Result(Match, Nil) {
  use <- bool.guard(when: size <= 0, return: Error(Nil))
  sized_match(table, tokens, size)
  |> result.lazy_or(fn() { phrase_match(table, tokens, size - 1) })
}

fn sized_match(
  table: Table,
  tokens: List(Token),
  size: Int,
) -> Result(Match, Nil) {
  use ngram <- result.try(token.ngram_at(tokens, size))
  use replacement <- result.try(dict.get(table.replacements, ngram))
  Ok(Match(found: ngram, replacement: replacement, size: size, offset: 0))
}

/// The lexer keeps a hyphen inside a word, so `state-of-the-art` stays whole.
/// That also hides a not-approved word in `auto-initiate`, so each part of a
/// hyphenated token gets one more look.
///
/// A part always reports Soft, even when the whole word reports Hard. A part can
/// come from a branch name such as `fix/initiate-flow`, and a Hard block there
/// stops real work. The first matching part wins, because one report per token
/// is enough to prompt a rewrite.
fn part_match(table: Table, head: Token) -> Result(Match, Nil) {
  use <- bool.guard(when: !string.contains(head.lower, "-"), return: Error(Nil))
  string.split(head.lower, on: "-")
  |> with_offsets
  |> list.find_map(part_lookup(table, _))
}

/// Pairs each part with its offset in the token. The extra 1 covers the hyphen
/// the split removed.
fn with_offsets(parts: List(String)) -> List(#(String, Int)) {
  parts
  |> list.map_fold(from: 0, with: fn(offset, part) {
    #(offset + string.length(part) + 1, #(part, offset))
  })
  |> pair.second
}

fn part_lookup(table: Table, part: #(String, Int)) -> Result(Match, Nil) {
  let #(text, offset) = part
  use replacement <- result.try(dict.get(table.replacements, text))
  Ok(Match(text, Replacement(..replacement, severity: Soft), 1, offset))
}

/// ASD limits redistribution of the full ASD-STE100 dictionary, which holds
/// roughly 900 approved words and roughly 1,200 words to avoid. This table
/// holds widely-cited pairs only. The standard's terminology allowance lets a
/// project add its own approved technical nouns and verbs. The host can load a
/// local file to extend this table.
///
/// The phrasal-verb, hedge and marketing lists come from
/// Ryuketsukami/ste-plain-writing (MIT).
pub fn entries() -> List(Entry) {
  list.flatten([
    word_entries(),
    phrase_entries(),
    phrasal_verb_entries(),
    hedge_entries(),
    marketing_entries(),
  ])
}

fn word_entries() -> List(Entry) {
  [
    #(silent_e_verb("initiate"), "start"),
    #(silent_e_verb("commence"), "start"),
    #(silent_e_verb("utilize"), "use"),
    #(silent_e_verb("utilise"), "use"),
    #(silent_e_verb("ensure"), "make sure"),
    #(silent_e_verb("terminate"), "stop"),
    #(silent_e_verb("facilitate"), "help"),
    #(silent_e_verb("locate"), "find"),
    #(silent_e_verb("indicate"), "show"),
    #(silent_e_verb("require"), "need"),
    #(silent_e_verb("purchase"), "buy"),
    #(silent_e_verb("leverage"), "use"),
    #(silent_e_verb("acquire"), "get"),
    #(silent_e_verb("demonstrate"), "show"),
    #(silent_e_verb("originate"), "start"),
    #(consonant_verb("perform"), "do"),
    #(consonant_verb("obtain"), "get"),
    #(consonant_verb("attempt"), "try"),
    #(consonant_verb("assist"), "help"),
    #(consonant_verb("permit"), "let"),
    #(y_verb("modify"), "change"),
    #(["begin", "begins", "began", "beginning"], "start"),
    #(["approximately"], "about"),
    #(["sufficient"], "enough"),
    #(["subsequent", "subsequently"], "next"),
    #(["prior"], "before"),
    #(["additional", "additionally"], "more"),
    #(["furthermore", "moreover"], "also"),
    #(["comprehensive", "comprehensively"], "complete"),
    #(["utilization"], "use"),
    #(["aforementioned"], "this"),
    #(["whilst"], "while"),
    #(["amongst"], "among"),
    #(["numerous", "myriad", "plethora"], "many"),
  ]
  |> list.map(fn(pair) { Entry(pair.0, pair.1, rule.NotApprovedWord) })
}

fn phrase_entries() -> List(Entry) {
  [
    #(["prior to"], "before"),
    #(["subsequent to"], "after"),
    #(["in order to"], "to"),
    #(["a variety of"], "some"),
    #(["in the event that"], "if"),
    #(["due to the fact that"], "because"),
    #(["is able to", "are able to"], "can"),
    #(["make use of", "makes use of"], "use"),
  ]
  |> list.map(fn(pair) { Entry(pair.0, pair.1, rule.NotApprovedWord) })
}

fn phrasal_verb_entries() -> List(Entry) {
  [
    #(["spin up", "spins up", "spun up"], "start"),
    #(["spin down", "spins down"], "stop"),
    #(["tear down", "tears down"], "remove"),
    #(["reach out", "reaches out", "reaching out"], "ask"),
    #(["dive into", "dives into", "diving into"], "examine"),
    #(["kick off", "kicks off"], "start"),
    #(["roll out", "rolls out"], "release"),
    #(["ramp up", "ramps up"], "increase"),
    #(["circle back"], "return to"),
    #(["drill down"], "examine"),
  ]
  |> list.map(fn(pair) { Entry(pair.0, pair.1, rule.PhrasalVerb) })
}

fn hedge_entries() -> List(Entry) {
  [
    "it is important to note", "it should be noted", "it is worth noting",
    "please note that", "as mentioned", "as noted above",
  ]
  |> list.map(fn(phrase) { Entry([phrase], "", rule.Hedge) })
}

fn marketing_entries() -> List(Entry) {
  [
    "seamless", "seamlessly", "robust", "powerful", "cutting-edge", "effortless",
    "effortlessly", "world-class", "next-generation", "revolutionary", "blazing",
    "lightning-fast", "elegant", "delightful", "turnkey", "best-in-class",
    "state-of-the-art", "game-changing", "battle-tested", "enterprise-grade",
    "supercharge", "unleash", "empower", "empowers",
  ]
  |> list.map(fn(word) { Entry([word], "", rule.Marketing) })
}

/// `initiate` -> `initiate`, `initiates`, `initiated`, `initiating`
fn silent_e_verb(infinitive: String) -> List(String) {
  let stem = string.drop_end(infinitive, 1)
  [infinitive, infinitive <> "s", infinitive <> "d", stem <> "ing"]
}

/// `perform` -> `perform`, `performs`, `performed`, `performing`
fn consonant_verb(infinitive: String) -> List(String) {
  [infinitive, infinitive <> "s", infinitive <> "ed", infinitive <> "ing"]
}

/// `modify` -> `modify`, `modifies`, `modified`, `modifying`
fn y_verb(infinitive: String) -> List(String) {
  let stem = string.drop_end(infinitive, 1)
  [infinitive, stem <> "ies", stem <> "ied", infinitive <> "ing"]
}
