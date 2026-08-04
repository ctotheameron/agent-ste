import gleam/list
import gleam/pair
import gleam/result
import gleam/string

/// One place where a needle splits the haystack, with the text on each side.
type Found {
  Found(column: Int, before: String, after: String)
}

/// Every 1-based column where `needle` appears.
pub fn columns(haystack: String, needle: String) -> List(Int) {
  found(haystack, needle)
  |> list.map(fn(one) { one.column })
}

/// Every 1-based column where `needle` appears as a whole word or phrase.
pub fn occurrences(haystack: String, needle: String) -> List(Int) {
  found(string.lowercase(haystack), string.lowercase(needle))
  |> list.filter(is_whole_word)
  |> list.map(fn(one) { one.column })
}

/// The column of the first whole-word match, or 1 when there is none.
pub fn first_column(haystack: String, needle: String) -> Int {
  occurrences(haystack, needle)
  |> list.first
  |> result.unwrap(or: 1)
}

/// A split gives an exact column for a repeat. `regexp.scan` cannot, because
/// gleam_regexp reports match content but no offset.
fn found(haystack: String, needle: String) -> List(Found) {
  string.split(haystack, on: needle)
  |> list.window_by_2
  |> list.map_fold(from: 0, with: fn(start, sides) {
    let #(before, after) = sides
    let at = start + string.length(before)
    #(at + string.length(needle), Found(at + 1, before, after))
  })
  |> pair.second
}

/// The caller lowercases both sides, so this list holds lowercase only.
const word_characters = "abcdefghijklmnopqrstuvwxyz0123456789_"

fn is_whole_word(one: Found) -> Bool {
  is_boundary(string.last(one.before)) && is_boundary(string.first(one.after))
}

/// An edge of the haystack counts as a boundary, so `Error` gives True.
fn is_boundary(edge: Result(String, Nil)) -> Bool {
  case edge {
    Error(_) -> True
    Ok(character) -> !string.contains(word_characters, character)
  }
}
