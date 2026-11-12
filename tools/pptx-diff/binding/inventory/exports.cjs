const ts = require(process.cwd() + '/node_modules/typescript')
const path = require('path'), fs = require('fs')
const SRC = path.resolve('packages/pptx-engine/src')
const files = fs.readdirSync(SRC).filter(f => f.endsWith('.ts')).map(f => path.join(SRC, f))
const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, noEmit: true, types: ['node'], typeRoots: [path.resolve('node_modules/@types')] })
const checker = program.getTypeChecker()
const out = []
for (const file of files) {
  const sf = program.getSourceFile(file); const ms = checker.getSymbolAtLocation(sf); if (!ms) continue
  const mod = path.basename(file, '.ts')
  for (const sym0 of checker.getExportsOfModule(ms)) {
    let sym = sym0; if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
    const decl = sym.valueDeclaration; if (!decl) continue
    if (path.basename(decl.getSourceFile().fileName, '.ts') !== mod) continue
    const t = checker.getTypeOfSymbolAtLocation(sym, decl)
    const sigs = t.getCallSignatures()
    if (ts.isClassDeclaration(decl)) { out.push({ mod, name: sym.name, kind: 'class' }); continue }
    if (!sigs.length) { out.push({ mod, name: sym.name, kind: 'const', type: checker.typeToString(t).slice(0, 80) }); continue }
    const s = sigs[0]
    out.push({ mod, name: sym.name, kind: 'function', params: s.parameters.map(p => p.name + ':' + checker.typeToString(checker.getTypeOfSymbolAtLocation(p, decl))), ret: checker.typeToString(s.getReturnType()) })
  }
}
fs.writeFileSync('tools/pptx-diff/binding/inventory/exports.json', JSON.stringify(out, null, 1))
const fns = out.filter(e => e.kind === 'function')
const has = re => fns.filter(f => f.params.some(p => re.test(p)))
console.log('exports', out.length, 'functions', fns.length, 'consts', out.filter(e=>e.kind==='const').length, 'classes', out.filter(e=>e.kind==='class').map(e=>e.mod+'.'+e.name).join(' '))
console.log('async', fns.filter(f => /^Promise</.test(f.ret)).length)
for (const [label, re] of [['OpenedPptx', /OpenedPptx/], ['PackageArchive', /PackageArchive/], ['Slide arg', /:Slide\b/], ['SlideDeck', /SlideDeck/], ['element arg', /Element\b|SlideElement/], ['bytes', /Uint8Array|Buffer|ArrayBuffer/], ['Map/Set', /Map<|Set</], ['callback', /=>/], ['JSZip', /JSZip/]]) {
  const l = has(re); console.log(label, l.length, l.map(f => f.name).join(' ').slice(0, 900))
}
