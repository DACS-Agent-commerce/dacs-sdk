# ParserSpec engine

The SDK default implements the DACS-2 §7.4.1 `ParserSpec` predicate formats.
It is the default used by `vetCore` when a caller does not inject a
`ParserEngine`.

| Format | Default capability | Extraction result |
| --- | --- | --- |
| `json` | RFC 9535 JSONPath, including filters and the Standard's LEI example | first selected JSON value, with its JSON shape preserved |
| `html` | CSS selectors over a detached `htmlparser2` DOM | text content of the first selected element |
| `xml` | XPath 1.0 over strict `@xmldom/xmldom` parsing | first selected node's value/text, or an XPath scalar |
| `raw` | RE2 syntax executed by `re2-wasm` | first capture, otherwise the complete first match |

The capability declaration is inspectable without executing a recipe:

```ts
import {
  defaultParserEngine,
  defaultParserEngineCapabilities,
} from "@kynesyslabs/dacs";

if (defaultParserEngine.capabilities !== defaultParserEngineCapabilities) {
  throw new Error("unexpected parser engine");
}
```

## Security and verdict boundary

The engine only reports predicate matches and extracted audit values. It never
decides `pass`, `fail`, `indeterminate`, or PSP-5 completeness. Those normative
decisions remain in `evaluateParserSpec`, based on the authenticated recipe and
attested response.

The default engine:

- does not execute scripts or JSONPath expressions as JavaScript;
- does not fetch subresources, navigate, or follow redirects;
- evaluates raw matchers and JSONPath `match()` / `search()` through RE2 rather
  than the JavaScript backtracking regular-expression engine;
- treats malformed bodies, expressions, selectors, and unsupported XPath
  scalar predicates as parser errors, which `evaluateParserSpec` maps to
  `error`;
- returns `null` for a missing audit-only `dataMap` selection without changing
  the decision.

HTML is parsed as detached data. Script elements may appear in the DOM but are
never run. XML parsing stops on parser diagnostics instead of recovering and
producing a verdict from malformed input.

## Injecting another engine

Callers may inject another `ParserEngine` through `VetDeps.parserEngine` or pass
it directly to `evaluateParserSpec`. An injected implementation must remain
deterministic and side-effect free. It should expose `capabilities` so operator
diagnostics can report its exact JSONPath, CSS, XPath, and regular-expression
contract.

Thrown engine exceptions are caught and become `error`; a custom engine cannot
escape the DACS-2 fail-closed decision boundary.
