// The Select mapping, extracted verbatim from UI.jsx.
const render = (options) => options.map((o) => {
  const isPair = o !== null && typeof o === "object";
  const val = isPair ? o.value : o;
  const lbl = isPair ? o.label : o;
  return { val, lbl };
});

let ok = 0, fail = 0;
const check = (l, c, x = "") => {
  console.log((c ? "  PASS  " : "  FAIL  ") + l + (!c && x ? "  :: " + JSON.stringify(x) : ""));
  c ? ok++ : fail++;
};

// The case that crashed: Join Strategy
const pairs = render([
  { value: "left",  label: "Left Join (Keep all sales.csv rows)" },
  { value: "inner", label: "Inner Join (Match only)" },
]);
check("object options unwrap to value + label",
  pairs[0].val === "left" && pairs[0].lbl.startsWith("Left Join"), pairs);
check("nothing renders as an object",
  pairs.every((p) => typeof p.lbl === "string" && typeof p.val === "string"), pairs);

// Every other page still passes strings
const strings = render(["pearson", "spearman", "kendall"]);
check("string options unchanged",
  strings.every((s) => s.val === s.lbl) && strings[0].val === "pearson", strings);

// The page also passes ["", ...cols] for the optional date key
const withBlank = render(["", "npi", "month"]);
check("leading blank option survives", withBlank[0].val === "" && withBlank.length === 3, withBlank);

// Defensive: null must not throw
check("null option does not throw", render([null])[0].val === null);

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
