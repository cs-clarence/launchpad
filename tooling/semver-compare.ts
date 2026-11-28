// Dependency-free on purpose: the release publishing scripts import it (see tooling/release.spec.ts).
// SemVer 2.0.0 precedence (section 11): build metadata is ignored, a prerelease sorts before
// its release, and prerelease identifiers compare numerically when both are numbers, otherwise
// as text, with numbers below text and a shorter list below a longer one it prefixes.
// Numeric identifiers have no length limit, so compare them as digit strings, not as numbers.
// Valid SemVer has no leading zeros, so a longer string is the larger number.
const compareDigits = (x: string, y: string) =>
    x.length !== y.length ? (x.length < y.length ? -1 : 1) : x === y ? 0 : x < y ? -1 : 1;

export function compareSemver(left: string, right: string): number {
    const parse = (v: string) => {
        const [core = "", pre] = v.split("+")[0]!.split(/-(.*)/s);
        return {
            core: core.split("."),
            pre: pre === undefined ? null : pre.split("."),
        };
    };
    const a = parse(left);
    const b = parse(right);
    for (let i = 0; i < 3; i++) {
        const order = compareDigits(a.core[i]!, b.core[i]!);
        if (order !== 0) return order;
    }
    if (a.pre === null || b.pre === null) {
        return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
    }
    for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
        const x = a.pre[i]!;
        const y = b.pre[i]!;
        if (x === y) continue;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) return compareDigits(x, y);
        if (xn !== yn) return xn ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return Math.sign(a.pre.length - b.pre.length);
}
