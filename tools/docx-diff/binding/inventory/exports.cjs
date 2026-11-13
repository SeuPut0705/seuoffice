const ts = require(process.cwd() + '/node_modules/typescript')
const path = require('path')
const entries = process.argv.slice(2)
const root = process.cwd() + '/packages/docx-engine'
const cfgPath = root + '/tsconfig.json'
const cfg = ts.getParsedCommandLineOfConfigFile(
  cfgPath,
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => console.error(d) },
)
const files = entries.map((e) => root + '/src/' + e)
const program = ts.createProgram(files, cfg.options)
const checker = program.getTypeChecker()
const out = []
for (const f of files) {
  const sf = program.getSourceFile(f)
  const sym = checker.getSymbolAtLocation(sf)
  if (!sym) {
    console.error('no module symbol', f)
    continue
  }
  for (let s of checker.getExportsOfModule(sym)) {
    const exportName = s.getName()
    let target = s
    if (s.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(s)
    const decl = (target.declarations || [])[0]
    const fl = target.flags
    let kind = 'other'
    if (fl & ts.SymbolFlags.Function) kind = 'function'
    else if (fl & ts.SymbolFlags.Class) kind = 'class'
    else if (fl & ts.SymbolFlags.Variable) kind = 'const'
    else if (fl & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) kind = 'type'
    else if (fl & ts.SymbolFlags.Enum) kind = 'enum'
    let sig = '',
      async = false,
      risks = []
    if (decl) {
      const type = checker.getTypeOfSymbolAtLocation(target, decl)
      if (
        kind === 'function' ||
        kind === 'class' ||
        (kind === 'const' && type.getCallSignatures().length)
      ) {
        const sigs = type.getCallSignatures()
        if (sigs.length) {
          sig = sigs
            .map((g) => checker.signatureToString(g, decl, ts.TypeFormatFlags.NoTruncation))
            .join(' | ')
          async = sigs.some((g) => /^Promise</.test(checker.typeToString(g.getReturnType())))
        }
        if (kind === 'class') sig = 'class ' + exportName
      } else if (kind === 'const') {
        sig = checker.typeToString(type, decl, ts.TypeFormatFlags.NoTruncation).slice(0, 200)
      }
      if (/Uint8Array|ArrayBuffer|Buffer/.test(sig)) risks.push('bytes')
      if (/\bMap<|\bSet</.test(sig)) risks.push('map/set')
      if (/\bDate\b/.test(sig)) risks.push('date')
      if (/JSZip/.test(sig)) risks.push('jszip')
      if (/=>/.test(sig.replace(/\):\s*[^|]*=>/g, ''))) risks.push('callback?')
    }
    const file = decl
      ? path.relative(root + '/src', decl.getSourceFile().fileName).replace(/\\/g, '/')
      : ''
    out.push({ name: exportName, kind, async, file, sig: sig.slice(0, 400), risks })
  }
}
require('fs').writeFileSync(process.env.OUT, JSON.stringify(out, null, 1))
console.log(out.length)
