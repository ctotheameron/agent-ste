import gleam/list
import gleam/string
import gleeunit
import gleeunit/should
import ste
import ste/rule.{type Violation}
import ste/source

pub fn main() {
  gleeunit.main()
}

fn rule_ids(violations: List(Violation)) -> List(String) {
  list.map(violations, fn(violation) { rule.to_string(violation.rule_id) })
}

fn columns(violations: List(Violation)) -> List(Int) {
  list.map(violations, fn(violation) { violation.column })
}

fn ids_for(text: String) -> List(String) {
  ste.lint(text) |> rule_ids |> list.unique |> list.sort(string.compare)
}

// --- the invariant that keeps the prompt honest ---

/// The roster and the linter must name the same rules. This holds in both
/// directions, so neither list can gain an entry alone.
pub fn every_declared_rule_is_implemented_test() {
  let declared =
    rule.all()
    |> list.map(rule.to_string)
    |> list.sort(string.compare)

  ste.implemented_rule_ids()
  |> should.equal(declared)
}

// --- dictionary ---

pub fn flags_a_not_approved_word_test() {
  ids_for("We will initiate the migration.")
  |> should.equal(["dictionary/not-approved-word"])
}

pub fn reports_the_approved_replacement_test() {
  let assert [violation, ..] = ste.lint("Utilize the cache.")
  violation.message
  |> should.equal("Use \"use\", not \"utilize\".")
}

pub fn accepts_approved_prose_test() {
  ste.lint("Start the service. Then test the output.")
  |> should.equal([])
}

pub fn matches_a_whole_word_only_test() {
  ste.lint("This task has high priority.")
  |> should.equal([])
}

pub fn flags_an_inflected_form_test() {
  ste.lint("The job initiated a retry.")
  |> rule_ids
  |> should.equal(["dictionary/not-approved-word"])
}

pub fn handles_a_silent_e_gerund_test() {
  ids_for("Initiating a rollback needs approval.")
  |> list.contains("dictionary/not-approved-word")
  |> should.be_true
}

pub fn ignores_case_test() {
  ids_for("ENSURE the file exists.")
  |> should.equal(["dictionary/not-approved-word"])
}

/// The phrase `is held` is passive, so two rules fire on this line.
pub fn reports_two_rules_on_one_line_test() {
  ids_for("ENSURE the lock is held.")
  |> should.equal(["dictionary/not-approved-word", "verb/passive"])
}

pub fn reports_an_exact_column_for_each_repeat_test() {
  ste.lint("initiate and initiate")
  |> columns
  |> should.equal([1, 14])
}

pub fn reports_the_line_number_test() {
  let assert [violation] = ste.lint("clean line\nplease utilize this")
  violation.line
  |> should.equal(2)
}

// --- longest match ---

pub fn flags_a_word_inside_a_hyphenated_token_test() {
  ste.lint("The job will auto-initiate a retry.")
  |> rule_ids
  |> should.equal(["dictionary/not-approved-word"])
}

pub fn reports_a_hyphen_part_as_soft_test() {
  let assert [violation] = ste.lint("The job will auto-initiate a retry.")
  violation.severity |> should.equal(rule.Soft)
}

pub fn points_at_the_part_not_the_token_test() {
  ste.lint("pre-utilize it")
  |> columns
  |> should.equal([5])
}

pub fn a_whole_word_still_reports_hard_test() {
  let assert [violation] = ste.lint("We will initiate it.")
  violation.severity |> should.equal(rule.Hard)
}

pub fn keeps_a_hyphenated_entry_whole_test() {
  let assert [violation] = ste.lint("A cutting-edge design.")
  violation.message |> should.equal("Delete \"cutting-edge\".")
  violation.column |> should.equal(3)
}

pub fn accepts_a_clean_hyphenated_token_test() {
  ste.lint("A hard-wrapped n-gram in a self-contained 1-based test.")
  |> should.equal([])
}

pub fn keeps_a_hyphenated_phrase_entry_whole_test() {
  let assert [violation] = ste.lint("A state-of-the-art design.")
  violation.message |> should.equal("Delete \"state-of-the-art\".")
}

pub fn a_phrase_beats_the_word_inside_it_test() {
  ste.lint("Do this prior to the merge.")
  |> list.length
  |> should.equal(1)
}

pub fn reports_the_phrase_not_the_word_test() {
  let assert [violation] = ste.lint("Do this prior to the merge.")
  violation.message
  |> should.equal("Use \"before\", not \"prior to\".")
}

pub fn matches_a_four_word_phrase_test() {
  let assert [violation] =
    ste.lint("It failed due to the fact that it timed out.")
  violation.message
  |> should.equal("Use \"because\", not \"due to the fact that\".")
}

// --- the linter masks code, and line numbers survive ---

pub fn ignores_a_fenced_code_block_test() {
  ste.lint("Start it.\n```\nconst modify = utilize(x);\n```\nTest it.")
  |> should.equal([])
}

pub fn ignores_an_inline_code_span_test() {
  ste.lint("Call `utilize()` to start.")
  |> should.equal([])
}

pub fn masking_keeps_the_line_count_test() {
  let text = "one\n```\ntwo\n```\nfour"
  source.mask(text)
  |> string.split(on: "\n")
  |> list.length
  |> should.equal(5)
}

pub fn masking_keeps_the_column_test() {
  let assert [violation] = ste.lint("Run `x` then utilize it.")
  violation.column
  |> should.equal(14)
}

pub fn reports_a_line_after_a_code_block_test() {
  let assert [violation] =
    ste.lint("Start it.\n```\ncode\n```\nPlease utilize this.")
  violation.line
  |> should.equal(5)
}

// --- style and verb rules ---

pub fn flags_a_semicolon_test() {
  ids_for("Start the job; then stop it.")
  |> should.equal(["style/semicolon"])
}

pub fn flags_a_contraction_test() {
  ids_for("The lock isn't held.")
  |> list.contains("style/contraction")
  |> should.be_true
}

pub fn flags_an_apostrophe_s_contraction_test() {
  ids_for("It's ready now.")
  |> list.contains("style/contraction")
  |> should.be_true
}

/// A possessive is not a contraction. The rule must not flag `repo's`.
pub fn does_not_flag_a_possessive_test() {
  ids_for("Check the repo's own docs and Cameron's notes.")
  |> list.contains("style/contraction")
  |> should.be_false
}

pub fn flags_every_unambiguous_contraction_test() {
  ["don't", "we're", "we've", "we'll", "we'd", "I'm"]
  |> list.filter(fn(form) {
    !list.contains(ids_for("Now " <> form <> " here."), "style/contraction")
  })
  |> should.equal([])
}

pub fn flags_the_progressive_tense_test() {
  ids_for("The worker is running the job.")
  |> list.contains("verb/progressive")
  |> should.be_true
}

pub fn flags_the_perfect_tense_test() {
  ids_for("We have received the file.")
  |> list.contains("verb/perfect")
  |> should.be_true
}

/// An `ing` word after `be` is not always a verb. `is nothing` and `is string`
/// name a thing, and `is missing` describes one.
pub fn a_noun_after_be_is_not_the_progressive_test() {
  [
    "The value is nothing.", "The type is string.", "The file is missing.",
    "The job is pending.", "The group is noncapturing.",
  ]
  |> list.all(fn(text) { !list.contains(ids_for(text), "verb/progressive") })
  |> should.be_true
}

/// An `ed` word after `have` is not always a participle. `has advanced` and
/// `had limited` describe the noun that follows.
pub fn an_adjective_after_have_is_not_the_perfect_test() {
  [
    "The API has advanced features.", "Access had limited scope.",
    "The page has detailed steps.",
  ]
  |> list.all(fn(text) { !list.contains(ids_for(text), "verb/perfect") })
  |> should.be_true
}

/// The exception list must not swallow a real report. `running` stays out of it.
pub fn a_real_verb_still_reports_test() {
  ids_for("The agent is running the build. We have completed the work.")
  |> fn(ids) {
    list.contains(ids, "verb/progressive") && list.contains(ids, "verb/perfect")
  }
  |> should.be_true
}

pub fn warns_on_the_passive_voice_test() {
  ids_for("The bolt was removed.")
  |> list.contains("verb/passive")
  |> should.be_true
}

pub fn a_passive_warning_is_soft_test() {
  let assert Ok(violation) =
    ste.lint("The bolt was removed.")
    |> list.find(fn(v) { v.rule_id == rule.Passive })
  violation.severity
  |> should.equal(rule.Soft)
}

pub fn flags_a_phrasal_verb_test() {
  ids_for("Spin up the worker.")
  |> should.equal(["style/phrasal-verb"])
}

pub fn flags_a_marketing_adjective_test() {
  ids_for("This is a seamless flow.")
  |> should.equal(["style/marketing"])
}

pub fn flags_a_hedge_test() {
  ids_for("It is important to note that the lock is held.")
  |> list.contains("style/hedge")
  |> should.be_true
}

// --- length ---

pub fn flags_a_sentence_over_the_descriptive_limit_test() {
  let long =
    "This one sentence runs on well past the hard limit of twenty five words"
    <> " in total, and so the linter must report it as a hard violation now."
  ids_for(long)
  |> list.contains("length/sentence")
  |> should.be_true
}

pub fn a_sentence_over_twenty_words_is_soft_test() {
  let assert Ok(violation) =
    ste.lint(
      "This sentence holds exactly twenty two words, so the linter must warn"
      <> " about it and not block the write of the file.",
    )
    |> list.find(fn(v) { v.rule_id == rule.SentenceLength })
  violation.severity
  |> should.equal(rule.Soft)
}

pub fn accepts_a_short_sentence_test() {
  ste.lint("Remove the bolt.")
  |> should.equal([])
}

pub fn flags_a_paragraph_over_six_sentences_test() {
  ids_for("One. Two. Three. Four. Five. Six. Seven.")
  |> list.contains("length/paragraph")
  |> should.be_true
}

pub fn a_blank_line_ends_a_paragraph_test() {
  ste.lint("One. Two. Three. Four.\n\nFive. Six. Seven. Eight.")
  |> rule_ids
  |> list.contains("length/paragraph")
  |> should.be_false
}

/// STE asks a writer to REPLACE a long prose paragraph with a vertical list. A
/// rule that counts the list as one paragraph punishes the recommended fix.
pub fn a_list_is_not_one_long_paragraph_test() {
  ids_for(
    "- One. Two.\n- Three. Four.\n- Five. Six.\n- Seven. Eight.\n- Nine. Ten.",
  )
  |> list.contains("length/paragraph")
  |> should.be_false
}

pub fn a_numbered_list_is_not_one_long_paragraph_test() {
  ids_for("1. One. Two.\n2. Three. Four.\n3. Five. Six.\n4. Seven. Eight.")
  |> list.contains("length/paragraph")
  |> should.be_false
}

pub fn a_table_is_not_a_paragraph_test() {
  ids_for(
    "| Rule | Severity |\n| --- | --- |\n| one. | hard. |\n| two. | soft. |"
    <> "\n| three. | hard. |\n| four. | soft. |\n| five. | hard. |",
  )
  |> list.contains("length/paragraph")
  |> should.be_false
}

pub fn a_heading_ends_a_paragraph_test() {
  ids_for("One. Two. Three.\n## A heading\nFour. Five. Six. Seven.")
  |> list.contains("length/paragraph")
  |> should.be_false
}

/// A hard-wrapped sentence must count once, not once per source line.
pub fn joins_a_wrapped_sentence_test() {
  ids_for(
    "The mechanism matters more, because discipline will drift. Layer 3\n"
    <> "already lints my replies. It writes a count to a widget, and I never\n"
    <> "see it. So the feedback never reaches me.",
  )
  |> should.equal([])
}

pub fn counts_a_wrapped_sentence_once_test() {
  let wrapped =
    "This one sentence is hard wrapped across three separate source lines,\n"
    <> "and it runs well past the limit of twenty five words, so the linter\n"
    <> "must report exactly one violation for it."
  ste.lint(wrapped)
  |> list.filter(fn(v) { v.rule_id == rule.SentenceLength })
  |> list.length
  |> should.equal(1)
}

pub fn maps_a_wrapped_sentence_to_its_own_line_test() {
  let assert Ok(violation) =
    ste.lint("Start the job.\nThen please utilize\nthe cache.")
    |> list.find(fn(v) { v.rule_id == rule.NotApprovedWord })
  #(violation.line, violation.column)
  |> should.equal(#(2, 13))
}

pub fn still_flags_a_long_prose_paragraph_test() {
  ids_for("One. Two. Three. Four.\nFive. Six. Seven. Eight. Nine.")
  |> list.contains("length/paragraph")
  |> should.be_true
}

// --- the JavaScript boundary ---

pub fn returns_json_for_the_host_test() {
  ste.lint_json("Utilize it.")
  |> should.equal(
    "[{\"ruleId\":\"dictionary/not-approved-word\",\"message\":\"Use \\\"use\\\", not \\\"utilize\\\".\",\"line\":1,\"column\":1,\"severity\":\"hard\"}]",
  )
}

pub fn returns_an_empty_array_for_clean_text_test() {
  ste.lint_json("Remove the bolt.")
  |> should.equal("[]")
}

// --- the prompt comes from the rule table ---

pub fn the_prompt_names_every_rule_test() {
  let prompt = ste.prompt_text()
  rule.all()
  |> list.map(rule.to_string)
  |> list.filter(fn(id) { !string.contains(prompt, id) })
  |> should.equal([])
}
