import gleam/list
import gleam/string

/// Every 1-based column where `needle` appears as a whole word or whole phrase.
/// A split-and-walk gives an exact column for a repeat. `regexp.scan` cannot:
/// gleam_regexp reports match content but no offset.
pub fn occurrences(haystack: String, needle: String) -> List(Int) {
  case string.split(string.lowercase(haystack), on: string.lowercase(needle)) {
    [] | [_] -> []
    [first, ..rest] -> walk(first, rest, needle, string.length(first), [])
  }
}

/// The column of the first whole-word match, or 1 when there is none.
pub fn first_column(haystack: String, needle: String) -> Int {
  case occurrences(haystack, needle) {
    [column, ..] -> column
    [] -> 1
  }
}

fn walk(
  before: String,
  rest: List(String),
  needle: String,
  start: Int,
  found: List(Int),
) -> List(Int) {
  case rest {
    [] -> list.reverse(found)
    [after, ..tail] -> {
      let bounded =
        is_boundary(last_grapheme(before)) && is_boundary(first_grapheme(after))
      let found = case bounded {
        True -> [start + 1, ..found]
        False -> found
      }
      let next_start = start + string.length(needle) + string.length(after)
      walk(after, tail, needle, next_start, found)
    }
  }
}

/// The caller lowercases both sides, so this list holds lowercase only.
const word_characters = "abcdefghijklmnopqrstuvwxyz0123456789_"

fn is_boundary(character: String) -> Bool {
  case character {
    "" -> True
    _ -> !string.contains(word_characters, character)
  }
}

fn last_grapheme(text: String) -> String {
  case string.last(text) {
    Ok(character) -> character
    Error(_) -> ""
  }
}

fn first_grapheme(text: String) -> String {
  case string.first(text) {
    Ok(character) -> character
    Error(_) -> ""
  }
}
