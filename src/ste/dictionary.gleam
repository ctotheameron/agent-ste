import gleam/dict.{type Dict}
import gleam/list
import gleam/set.{type Set}
import gleam/string
import ste/rule.{type Severity, type Violation, Hard, Soft, Violation}
import ste/token.{type Token}

pub type Entry {
  /// `forms` lists every spelling to flag. An explicit list beats a suffix
  /// regexp: `\bprior\w*` also matches "priority", and an English verb stem
  /// drops its "e" before "-ing".
  Entry(
    forms: List(String),
    approved: String,
    rule_id: String,
    severity: Severity,
  )
}

pub type Replacement {
  Replacement(approved: String, rule_id: String, severity: Severity)
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

/// Build this ONCE and reuse it. Gleam has no module-level mutable state and a
/// `const` cannot hold a Dict, so the host owns the value.
pub fn table() -> Table {
  let forms =
    entries()
    |> list.flat_map(fn(entry) {
      list.map(entry.forms, fn(form) {
        #(
          form,
          Replacement(
            approved: entry.approved,
            rule_id: entry.rule_id,
            severity: entry.severity,
          ),
        )
      })
    })

  let phrases = list.filter(forms, fn(pair) { phrase_length(pair.0) > 1 })

  Table(
    replacements: dict.from_list(forms),
    phrase_starts: phrases
      |> list.filter_map(fn(pair) { first_word(pair.0) })
      |> set.from_list,
    max_words: list.fold(phrases, 1, fn(most, pair) {
      int_max(most, phrase_length(pair.0))
    }),
  )
}

fn first_word(phrase: String) -> Result(String, Nil) {
  case string.split(phrase, on: " ") {
    [head, ..] -> Ok(head)
    [] -> Error(Nil)
  }
}

fn phrase_length(phrase: String) -> Int {
  string.split(phrase, on: " ") |> list.length
}

fn int_max(left: Int, right: Int) -> Int {
  case left > right {
    True -> left
    False -> right
  }
}

pub fn check(
  table: Table,
  tokens: List(Token),
  line_number: Int,
) -> List(Violation) {
  walk(table, tokens, line_number, [])
}

/// Greedy longest match. `prior to` must consume both tokens, or the entry for
/// `prior` reports the same span again.
fn walk(
  table: Table,
  tokens: List(Token),
  line_number: Int,
  found: List(Violation),
) -> List(Violation) {
  case tokens {
    [] -> list.reverse(found)
    [first, ..rest] ->
      case longest_match(table, tokens, table.max_words) {
        Error(_) -> walk(table, rest, line_number, found)
        Ok(match) ->
          walk(table, list.drop(tokens, match.size), line_number, [
            Violation(
              rule_id: match.replacement.rule_id,
              message: message_for(match.replacement, match.found),
              line: line_number,
              column: first.column + match.offset,
              severity: match.replacement.severity,
            ),
            ..found
          ])
      }
  }
}

fn message_for(replacement: Replacement, found: String) -> String {
  case replacement.approved {
    "" -> "Delete \"" <> found <> "\"."
    approved -> "Use \"" <> approved <> "\", not \"" <> found <> "\"."
  }
}

fn longest_match(
  table: Table,
  tokens: List(Token),
  size: Int,
) -> Result(Match, Nil) {
  case tokens {
    [] -> Error(Nil)
    [first, ..] ->
      case set.contains(table.phrase_starts, first.lower) {
        True -> try_sizes(table, tokens, size)
        False -> match_single(table, first)
      }
  }
}

/// The hot path: one lookup, no list or string allocation.
fn match_single(table: Table, first: Token) -> Result(Match, Nil) {
  case dict.get(table.replacements, first.lower) {
    Ok(replacement) -> Ok(Match(first.lower, replacement, 1, 0))
    Error(_) -> match_part(table, first)
  }
}

/// The lexer keeps a hyphen inside a word, so `state-of-the-art` stays whole.
/// That also hides a not-approved word in `auto-initiate`, so each part of a
/// hyphenated token gets one more look.
///
/// A part always reports Soft, even when the whole word reports Hard. A part can
/// come from a branch name such as `fix/initiate-flow`, and a Hard block there
/// stops real work. The first matching part wins, because one report per token
/// is enough to prompt a rewrite.
fn match_part(table: Table, first: Token) -> Result(Match, Nil) {
  case string.contains(first.lower, "-") {
    False -> Error(Nil)
    True -> part_match(table, string.split(first.lower, on: "-"), 0)
  }
}

fn part_match(
  table: Table,
  parts: List(String),
  offset: Int,
) -> Result(Match, Nil) {
  case parts {
    [] -> Error(Nil)
    [part, ..rest] ->
      case dict.get(table.replacements, part) {
        Ok(replacement) ->
          Ok(Match(part, Replacement(..replacement, severity: Soft), 1, offset))
        // One more for the hyphen the split removed.
        Error(_) -> part_match(table, rest, offset + string.length(part) + 1)
      }
  }
}

fn try_sizes(
  table: Table,
  tokens: List(Token),
  size: Int,
) -> Result(Match, Nil) {
  case size <= 0 {
    True -> Error(Nil)
    False ->
      case token.ngram_at(tokens, size) {
        Error(_) -> try_sizes(table, tokens, size - 1)
        Ok(ngram) ->
          case dict.get(table.replacements, ngram) {
            Ok(replacement) -> Ok(Match(ngram, replacement, size, 0))
            Error(_) -> try_sizes(table, tokens, size - 1)
          }
      }
  }
}

const not_approved = "dictionary/not-approved-word"

const phrasal = "style/phrasal-verb"

const hedge = "style/hedge"

const marketing = "style/marketing"

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
  |> list.map(fn(pair) { Entry(pair.0, pair.1, not_approved, Hard) })
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
  |> list.map(fn(pair) { Entry(pair.0, pair.1, not_approved, Hard) })
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
  |> list.map(fn(pair) { Entry(pair.0, pair.1, phrasal, Hard) })
}

fn hedge_entries() -> List(Entry) {
  [
    "it is important to note", "it should be noted", "it is worth noting",
    "please note that", "as mentioned", "as noted above",
  ]
  |> list.map(fn(phrase) { Entry([phrase], "", hedge, Soft) })
}

fn marketing_entries() -> List(Entry) {
  [
    "seamless", "seamlessly", "robust", "powerful", "cutting-edge", "effortless",
    "effortlessly", "world-class", "next-generation", "revolutionary", "blazing",
    "lightning-fast", "elegant", "delightful", "turnkey", "best-in-class",
    "state-of-the-art", "game-changing", "battle-tested", "enterprise-grade",
    "supercharge", "unleash", "empower", "empowers",
  ]
  |> list.map(fn(word) { Entry([word], "", marketing, Soft) })
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
