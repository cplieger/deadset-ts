import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { CHUNK_LENGTH } from "../json-chunks.ts";
import { RenderError } from "./reporter.ts";
import { parseTemplate, renderTemplate, TemplateError } from "./template.ts";
import { whole } from "../../__test-helpers__/whole.ts";

/** A document shaped like a report's members, by the names the JSON report gives them. */
const DOCUMENT = {
  schema_version: "6.0.0",
  findings: [
    {
      code: "DS1001",
      position: { path: "src/a.ts", line: 3 },
      symbol: { name: "alpha" },
      retained_by: [],
    },
    {
      code: "DS1503",
      position: { path: "src/b.ts", line: 10 },
      symbol: { name: "beta" },
      retained_by: [],
    },
  ],
  stale_suppressions: [],
  totals: { findings: 2, by_severity: { allow: 0, warn: 1, deny: 1 }, omitted: 0 },
};

function render(source: string, document: unknown = DOCUMENT): string {
  return whole(renderTemplate(parseTemplate(source), document));
}

describe("a template over the report document", () => {
  it("names the document's members by the names the JSON report gives them", () => {
    expect(
      render(
        "{{range .findings}}{{.position.path}}:{{.position.line}} {{.code}} {{.symbol.name}}\n{{end}}{{.totals.findings}} findings\n",
      ),
    ).toBe("src/a.ts:3 DS1001 alpha\nsrc/b.ts:10 DS1503 beta\n2 findings\n");
  });

  it("trims the white space a trim marker faces and drops a comment", () => {
    expect(render("a  {{- /* note */ -}}  b {{- 1 -}} \n c")).toBe("ab1c");
  });

  it("runs the else branch of a range over an empty list and of an if over a false value", () => {
    expect(render("{{range .stale_suppressions}}x{{else}}none{{end}}")).toBe("none");
    expect(render("{{if .totals.omitted}}cut{{else if .findings}}whole{{else}}empty{{end}}")).toBe(
      "whole",
    );
  });

  it("binds a range's index and element, and a with's value as the dot", () => {
    expect(render("{{range $i, $f := .findings}}{{$i}}={{$f.code}} {{end}}")).toBe(
      "0=DS1001 1=DS1503 ",
    );
    expect(render("{{with .totals.by_severity}}{{.deny}}/{{.warn}}{{end}}")).toBe("1/1");
  });

  it("ranges over an object's values in key order, and stops at a break", () => {
    expect(render("{{range $k, $v := .totals.by_severity}}{{$k}}{{$v}} {{end}}")).toBe(
      "allow0 deny1 warn1 ",
    );
    expect(render("{{range .findings}}{{.code}}{{break}}{{end}}")).toBe("DS1001");
    expect(
      render('{{range .findings}}{{if eq .code "DS1001"}}{{continue}}{{end}}{{.code}}{{end}}'),
    ).toBe("DS1503");
  });

  it("calls the comparison, logic, length, index and formatting functions", () => {
    expect(
      render('{{len .findings}} {{index .findings 1 "code"}} {{printf "%s:%d" .schema_version 7}}'),
    ).toBe("2 DS1503 6.0.0:7");
    expect(
      render('{{and .findings .totals.omitted}}|{{or .totals.omitted "none"}}|{{not .findings}}'),
    ).toBe("0|none|false");
    expect(render('{{lt 1 2}} {{ge .totals.findings 3}} {{ne .schema_version "5"}}')).toBe(
      "true false true",
    );
    expect(render('{{print 1 2 "x" 3}}|{{println "a" 1}}|{{.findings | len}}')).toBe(
      "1 2x3|a 1\n|2",
    );
  });

  it("assigns a declared variable and reads it later in the same scope", () => {
    expect(render("{{$n := 0}}{{range .findings}}{{$n = .position.line}}{{end}}{{$n}}")).toBe("10");
  });

  it("declares a variable inside a parenthesized pipeline in the enclosing scope, as Go does", () => {
    expect(render("{{print ($x := 1)}}{{$x}}")).toBe("11");
    expect(render("{{print ($x := 1)}}{{$x = 2}}{{$x}}")).toBe("12");
  });

  it("assigns the outer variables a range with = names, the whole value first, as Go does", () => {
    const lists = { l: ["a", "b"], e: [] };
    expect(render("{{$x := 0}}{{range $x = .l}}{{$x}}{{end}}{{$x}}", lists)).toBe("abb");
    expect(render("{{$i := 9}}{{$x := 0}}{{range $i, $x = .l}}{{end}}{{$i}}{{$x}}", lists)).toBe(
      "1b",
    );
    expect(render("{{$x := 0}}{{range $x = .e}}{{end}}{{$x}}", lists)).toBe("[]");
    expect(render("{{range $i, $x := .e}}{{else}}{{$i}}{{$x}}{{end}}", lists)).toBe("[][]");
  });

  it("prints a list and an object in the bracketed form and a null as no value", () => {
    expect(
      render("{{.totals.by_severity}} {{.findings | len | print}} {{.missing_is_null}}", {
        ...DOCUMENT,
        missing_is_null: null,
      }),
    ).toBe("map[allow:0 deny:1 warn:1] 2 <no value>");
  });

  it("fails the rendering on a member the document does not carry, naming it", () => {
    expect(() => render("{{.totals.pending}}")).toThrow(
      new RenderError('the document has no member "pending" here'),
    );
  });

  it("fails the rendering on a comparison between two kinds of value", () => {
    expect(() => render('{{eq 1 "1"}}')).toThrow(RenderError);
  });

  it("keeps the white space no trim marker faces", () => {
    expect(render("  a")).toBe("  a");
    expect(render("a {{  1}}")).toBe("a 1");
  });

  it("trims only the white space at the edge a trim marker faces", () => {
    expect(render("{{1 -}}a b")).toBe("1a b");
    expect(render("a b {{- 1}}")).toBe("a b1");
  });

  it("drops a comment that is the whole action, keeping the text after it", () => {
    expect(render("a{{/* c */}} b")).toBe("a b");
  });

  it("prints the dot itself", () => {
    expect(render("{{with .schema_version}}{{.}}{{end}}")).toBe("6.0.0");
  });

  it("reads a dot after a field chain as an operand of its own", () => {
    expect(render("{{print .a.}}", { a: "x" })).toBe("xmap[a:x]");
  });

  it("runs a pipeline in parentheses, nested ones and pipes inside them included", () => {
    expect(render("{{print (print (print 7))}}")).toBe("7");
    expect(render("{{(1 | print)}}")).toBe("1");
  });

  it("fails the rendering on a field of a value that is not an object, naming its kind", () => {
    expect(() => render("{{.a.b}}", { a: "x" })).toThrow(
      new RenderError("cannot evaluate field b in a string"),
    );
    expect(() => render("{{.a.b}}", { a: null })).toThrow(
      new RenderError("cannot evaluate field b in a nil"),
    );
  });

  it("fails the rendering on the length of a number", () => {
    expect(() => render("{{len 5}}")).toThrow(new RenderError("len of a number"));
  });

  it("reads each kind of value as true or false", () => {
    const truth = "{{range .}}{{if .}}t{{else}}f{{end}}{{end}}";

    expect(render(truth, [null, false, true, 0, 1, -1, "", "x", [], [0], {}, { a: 0 }])).toBe(
      "fftfttftftft",
    );
  });

  it("prints a null inside a list and an object as nil", () => {
    expect(render("{{.l}} {{.o}}", { l: [null], o: { a: null } })).toBe("[<nil>] map[a:<nil>]");
  });

  it("prints a boolean the document holds", () => {
    expect(render("{{.b}} {{.c}}", { b: true, c: false })).toBe("true false");
  });

  it("names a list and a nil by their kinds", () => {
    expect(() => render("{{.a.b}}", { a: [] })).toThrow(
      new RenderError("cannot evaluate field b in a list"),
    );
    expect(() => render("{{eq .a .b}}", { a: [1], b: [1] })).toThrow(
      new RenderError("eq: incompatible types for comparison: list and list"),
    );
    expect(() => render("{{eq nil nil}}")).toThrow(
      new RenderError("eq: incompatible types for comparison: nil and nil"),
    );
  });

  it("compares numbers, strings and booleans", () => {
    expect(render("{{eq 1 1}} {{eq 1 2}} {{ne 1 1}} {{ne 1 2}}")).toBe("true false false true");
    expect(render("{{eq true true}} {{eq true false}} {{ne true false}}")).toBe("true false true");
    expect(render("{{lt 1 2}} {{lt 1 1}} {{lt 2 1}}")).toBe("true false false");
    expect(render("{{le 1 2}} {{le 1 1}} {{le 2 1}}")).toBe("true true false");
    expect(render("{{gt 1 2}} {{gt 1 1}} {{gt 2 1}}")).toBe("false false true");
  });

  it("orders strings by code point, a prefix first", () => {
    expect(render('{{lt "ab" "ac"}} {{lt "b" "a"}} {{lt "a" "ab"}} {{lt "ab" "a"}}')).toBe(
      "true false true false",
    );
    expect(render('{{lt "\\uffffa" "\\uffffb"}} {{lt "\\U0001F600a" "\\U0001F600b"}}')).toBe(
      "true true",
    );
  });

  it("fails the rendering on an order between two booleans", () => {
    expect(() => render("{{lt true false}}")).toThrow(
      new RenderError("lt: booleans have no order"),
    );
  });

  it("fails the rendering on a function given the wrong number of operands", () => {
    expect(() => render("{{not 1 2}}")).toThrow(
      new RenderError("not takes 1 operand(s), and 2 were given"),
    );
    expect(() => render('{{len "a" "b"}}')).toThrow(
      new RenderError("len takes 1 operand(s), and 2 were given"),
    );
    expect(() => render("{{ne 1 2 3}}")).toThrow(
      new RenderError("ne takes 2 operand(s), and 3 were given"),
    );
    expect(() => render("{{lt 1 2 3}}")).toThrow(
      new RenderError("lt takes 2 operand(s), and 3 were given"),
    );
    expect(() => render("{{eq 1}}")).toThrow(new RenderError("eq takes at least two operands"));
    expect(() => render("{{print not}}")).toThrow(
      new RenderError("not takes 1 operand(s), and 0 were given"),
    );
    expect(() => render("{{and}}")).toThrow(new RenderError("and takes at least one operand"));
  });

  it("indexes a list from its first element and refuses a negative key", () => {
    expect(render("{{index .l 0}}", { l: ["a", "b"] })).toBe("a");
    expect(() => render("{{index .l -1}}", { l: ["a"] })).toThrow(
      new RenderError("index out of range: -1"),
    );
    expect(() => render("{{index .l nil}}", { l: ["a"] })).toThrow(
      new RenderError("index of <no value> into a list"),
    );
  });

  it("prints a null operand of print, println and printf as nil", () => {
    expect(render('{{print nil}}|{{println nil}}|{{printf "%v %q" nil nil}}')).toBe(
      '<nil>|<nil>\n|<nil> "<nil>"',
    );
  });

  it("quotes a space as itself", () => {
    expect(render('{{printf "%q" "a b"}}')).toBe('"a b"');
  });

  it("fails printf on a verb with no operand, an operand of the wrong kind, or one left over", () => {
    expect(() => render('{{printf "%s"}}')).toThrow(new RenderError("printf: %s has no operand"));
    expect(() => render('{{printf "%d" "x"}}')).toThrow(
      new RenderError("printf: %d over a string"),
    );
    expect(() => render('{{printf "%d" .v}}', { v: 1.5 })).toThrow(
      new RenderError("printf: %d over a number"),
    );
    expect(() => render('{{printf "%t" 1}}')).toThrow(new RenderError("printf: %t over a number"));
    expect(() => render('{{printf "%s" 1 2}}')).toThrow(
      new RenderError("printf: 1 operand(s) left over"),
    );
  });

  it("fails the rendering on an operand given to a value that is not a function", () => {
    expect(() => render("{{1 2}}")).toThrow(
      new RenderError("cannot give an argument to a non-function"),
    );
    expect(() => render("{{1 | 2}}")).toThrow(
      new RenderError("cannot give an argument to a non-function"),
    );
  });

  it("ends and and or at the first operand that decides them, the piped one last", () => {
    expect(render("{{or 1 0}} {{and 0 .missing}}")).toBe("1 0");
    expect(render('{{"x" | or 0}}')).toBe("x");
  });

  it("keeps the dot of an if whose branch is taken", () => {
    expect(render("{{if .totals}}{{.schema_version}}{{end}}")).toBe("6.0.0");
  });

  it("binds a variable an if or a with declares inside its branch", () => {
    expect(render("{{if $x := 1}}{{$x}}{{end}}")).toBe("1");
    expect(render("{{with $x := 2}}{{$x}}{{.}}{{end}}")).toBe("22");
  });

  it("keeps a variable an if or a range declares again to its own scope", () => {
    expect(render("{{$x := 1}}{{if 1}}{{$x := 2}}{{end}}{{$x}}")).toBe("1");
    expect(render("{{$x := 1}}{{range $x := .l}}{{end}}{{$x}}", { l: ["a", "b"] })).toBe("1");
    expect(
      render("{{if 1}}{{$x := 0}}{{range $x := .l}}{{end}}{{$x}}{{end}}", { l: ["a", "b"] }),
    ).toBe("0");
  });

  it("binds a range's one variable to each element, declared or assigned", () => {
    expect(render("{{range $f := .l}}{{$f}}{{end}}", { l: ["a", "b"] })).toBe("ab");
    expect(render("{{$x := 0}}{{range $x = .l}}{{$x}}{{end}}", { l: ["a", "b"] })).toBe("ab");
  });

  it("runs the else branch of a range over a null", () => {
    expect(render("{{range .n}}x{{else}}none{{end}}", { n: null })).toBe("none");
  });

  it("fails the rendering on a variable only the branch not taken declares", () => {
    expect(() => render("{{if 0}}{{$x := 1}}{{else}}{{$x = 2}}{{end}}")).toThrow(
      new RenderError("undefined variable $x"),
    );
  });
});

describe("a template's rendering in pieces", () => {
  it("is no piece for a template that writes nothing", () => {
    expect(renderTemplate(parseTemplate(""), {})).toEqual([]);
  });

  it("joins small writes into one piece", () => {
    expect(renderTemplate(parseTemplate("a{{1}}b"), {})).toEqual(["a1b"]);
  });

  it("starts a new piece once one reaches the chunk length", () => {
    const full = "x".repeat(CHUNK_LENGTH);

    expect(renderTemplate(parseTemplate("{{.s}}{{.s}}"), { s: full })).toEqual([full, full]);
  });
});

describe("a template that does not parse", () => {
  it.each([
    ["an unclosed action", "{{.findings"],
    ["an if with no end", "{{if .findings}}x"],
    ["an end with nothing open", "x{{end}}"],
    ["an else outside a control", "{{else}}"],
    ["an undefined variable", "{{$x}}"],
    ["a function that is not defined", "{{upper .schema_version}}"],
    ["a function the subset does not implement", "{{html .schema_version}}"],
    ["a template definition", '{{define "x"}}y{{end}}'],
    ["a break outside a range", "{{break}}"],
    ["an empty action", "{{}}"],
    ["an unterminated string", '{{print "x}}'],
    ["an unclosed comment", "{{/* x }}"],
    ["an else if inside a range", "{{range .findings}}{{else if .x}}{{end}}"],
  ])("refuses %s", (_what, source) => {
    expect(() => parseTemplate(source)).toThrow(TemplateError);
  });

  it.each([
    ["a string broken by a line", '{{print "a\nb"}}', "unterminated quoted string"],
    ["a hexadecimal escape of no hexadecimal digits", '{{print "\\xZZ"}}', "the escape \\x"],
    ["a hexadecimal escape opening on a digit", '{{print "\\x1Z"}}', "the escape \\x"],
    ["a hexadecimal escape closing on a digit", '{{print "\\xZ1"}}', "the escape \\x"],
    ["a numeric escape the template's end cuts short", '{{print "\\u12', "the escape \\u"],
    ["an unterminated raw string", "{{print `x}}", "unterminated raw quoted string"],
    ["a number with a leading dot", "{{.5}}", "a number is written with a leading digit"],
    ["an unclosed comment", "{{/* x }}", "unclosed comment"],
    ["a comment whose opening slash is its only closing one", "{{/*/}}", "unclosed comment"],
    ["a comment followed by more of its action", "{{/* c */ x}}", "a comment ends the action"],
    ["a break with an operand", "{{range .findings}}{{break 1}}{{end}}", "takes nothing"],
    ["a template call", '{{template "x"}}', "{{template}} is not supported"],
    ["a break after its range ended", "{{range .findings}}{{end}}{{break}}", "outside {{range}}"],
    ["a break inside an if", "{{if 1}}{{break}}{{end}}", "outside {{range}}"],
    ["an end with an operand", "{{if 1}}{{end 1}}", "unexpected tokens after {{end}}"],
    [
      "an else range inside a range",
      "{{range .findings}}{{else range .findings}}{{end}}",
      "unexpected tokens after {{else}}",
    ],
    ["an else with inside an if", "{{if 1}}{{else with 2}}{{end}}", "unexpected tokens after"],
    ["an else with no end", "{{if 1}}a{{else}}b", "has no {{end}} after its {{else}}"],
    ["an else whose end has an operand", "{{if 1}}a{{else}}b{{end 1}}", "has no {{end}} after"],
    ["a variable read after its if", "{{if 1}}{{$x := 1}}{{end}}{{$x}}", "undefined variable $x"],
    ["a declaration of no variable", "{{:= 1}}", "unexpected := in an operand"],
    ["a declaration of a literal", "{{1 := 2}}", "unexpected := in an operand"],
    ["a declaration of the root variable", "{{$ := 1}}", "unexpected := in an operand"],
    ["range variables with no comma", "{{range $i $f := .findings}}{{end}}", "variable $i"],
    ["range variables split by a pipe", "{{range $i | $f := .findings}}{{end}}", "variable $i"],
    ["a range variable that is a literal", "{{range $i, 1 := .findings}}{{end}}", "variable $i"],
    ["two variables outside a range", "{{$a, $b := 1}}", "undefined variable $a"],
    ["an assignment to an undeclared variable", "{{$x = 1}}", "undefined variable $x"],
    ["a pipe with nothing before it", "{{| len}}", "missing command in a pipeline"],
    ["a pipe with nothing after it", "{{1 |}}", "missing command in a pipeline"],
    ["an action of nothing", "{{}}", "missing value for action"],
    ["an unclosed left parenthesis", "{{(1}}", "unclosed left parenthesis"],
    ["a field of a literal", '{{"x".a}}', "a literal has no field"],
  ])("refuses %s, saying why", (_what, source, why) => {
    expect(() => parseTemplate(source)).toThrow(TemplateError);
    expect(() => parseTemplate(source)).toThrow(why);
  });

  it("names the line the refusal is at", () => {
    expect(() => parseTemplate("a\nb\n{{nope}}")).toThrow(/^line 3: /u);
    expect(() => parseTemplate("abc\n{{nope}}")).toThrow(/^line 2: /u);
  });
});

/** The published template vector cases, each by its directory name, in ascending order. */
function templateCases(): string[] {
  return readdirSync(fixture("vectors", "template"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** One file of one template vector case as text, or undefined where the case holds none. */
function caseFile(name: string, file: string): string | undefined {
  const path = fixture("vectors", "template", name, file);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** What a case's template does: its rendering, or the exit code the run ends with. */
function outcomeOf(name: string): string {
  let template;
  try {
    template = parseTemplate(caseFile(name, "template.tmpl") ?? "");
  } catch (error: unknown) {
    if (error instanceof TemplateError) {
      return "exit 2";
    }
    throw error;
  }
  try {
    return whole(
      renderTemplate(template, JSON.parse(caseFile(name, "report.json") ?? "") as unknown),
    );
  } catch (error: unknown) {
    if (error instanceof RenderError) {
      return "exit 3";
    }
    throw error;
  }
}

describe("the published template vectors", () => {
  it("are the case set this suite runs", () => {
    expect(templateCases()).toEqual([
      "character-constant",
      "comparison-of-two-kinds",
      "field-on-a-string",
      "findings-by-member-name",
      "function-outside-the-subset",
      "index-of-a-missing-key",
      "index-past-the-array",
      "integers-print-in-decimal",
      "length-in-bytes",
      "member-the-document-lacks",
      "nil-as-a-command",
      "nil-as-an-argument",
      "number-with-a-fraction",
      "octal-escape",
      "print-spacing",
      "printf-operand-left-over",
      "printf-verb-outside-the-subset",
      "printf-verbs",
      "range-orders-and-stops",
      "strings-compare-by-bytes",
      "template-definition",
      "truth-and-logic",
      "unclosed-action",
      "values-print-bracketed",
      "variables-and-trim-markers",
      "variables-in-parentheses-and-range-assignment",
    ]);
  });

  it.each(templateCases())("%s ends as the case states", (name) => {
    const exit = caseFile(name, "expected_exit");

    expect(outcomeOf(name)).toBe(
      exit === undefined ? caseFile(name, "expected.txt") : `exit ${exit.trim()}`,
    );
  });
});
