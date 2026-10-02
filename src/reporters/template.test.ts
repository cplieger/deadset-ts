import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { RenderError } from "./reporter.ts";
import { parseTemplate, renderTemplate, TemplateError } from "./template.ts";

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
      code: "DS1104",
      position: { path: "src/b.ts", line: 10 },
      symbol: { name: "beta" },
      retained_by: [],
    },
  ],
  stale_suppressions: [],
  totals: { findings: 2, by_severity: { allow: 0, warn: 1, deny: 1 }, omitted: 0 },
};

function render(source: string, document: unknown = DOCUMENT): string {
  return renderTemplate(parseTemplate(source), document);
}

describe("a template over the report document", () => {
  it("names the document's members by the names the JSON report gives them", () => {
    expect(
      render(
        "{{range .findings}}{{.position.path}}:{{.position.line}} {{.code}} {{.symbol.name}}\n{{end}}{{.totals.findings}} findings\n",
      ),
    ).toBe("src/a.ts:3 DS1001 alpha\nsrc/b.ts:10 DS1104 beta\n2 findings\n");
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
      "0=DS1001 1=DS1104 ",
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
    ).toBe("DS1104");
  });

  it("calls the comparison, logic, length, index and formatting functions", () => {
    expect(
      render('{{len .findings}} {{index .findings 1 "code"}} {{printf "%s:%d" .schema_version 7}}'),
    ).toBe("2 DS1104 6.0.0:7");
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

  it("names the line the refusal is at", () => {
    expect(() => parseTemplate("a\nb\n{{nope}}")).toThrow(/^line 3: /u);
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
    return renderTemplate(template, JSON.parse(caseFile(name, "report.json") ?? "") as unknown);
  } catch (error: unknown) {
    if (error instanceof RenderError) {
      return "exit 3";
    }
    throw error;
  }
}

describe("the published template vectors", () => {
  it.each(templateCases())("%s ends as the case states", (name) => {
    const exit = caseFile(name, "expected_exit");

    expect(outcomeOf(name)).toBe(
      exit === undefined ? caseFile(name, "expected.txt") : `exit ${exit.trim()}`,
    );
  });
});
