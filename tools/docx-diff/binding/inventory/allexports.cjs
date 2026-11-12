const ts = require(process.cwd() + '/node_modules/typescript')
const path = require('path'), fs=require('fs')
const root = process.cwd() + '/packages/docx-engine'
const cfg = ts.getParsedCommandLineOfConfigFile(root + '/tsconfig.json', {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => console.error(d) })
const files = fs.readdirSync(root+'/src').filter(f=>f.endsWith('.ts')).map(f=>root+'/src/'+f)
const program = ts.createProgram(files, cfg.options)
const checker = program.getTypeChecker()
const out = []
for (const f of files) {
  const sf = program.getSourceFile(f); const sym = checker.getSymbolAtLocation(sf); if (!sym) continue
  for (const s of checker.getExportsOfModule(sym)) {
    let t = s; if (s.flags & ts.SymbolFlags.Alias) t = checker.getAliasedSymbol(s)
    const decl=(t.declarations||[])[0]; if(!decl) continue
    const declFile = path.relative(root+'/src', decl.getSourceFile().fileName).replace(/\\/g,'/')
    if (declFile !== path.relative(root+'/src', f).replace(/\\/g,'/')) continue // only own declarations
    const fl=t.flags; let kind='other'
    if (fl&ts.SymbolFlags.Function) kind='function'; else if(fl&ts.SymbolFlags.Class) kind='class'; else if(fl&ts.SymbolFlags.Variable) kind='const'
    else if (fl&(ts.SymbolFlags.Interface|ts.SymbolFlags.TypeAlias)) kind='type'; else if(fl&ts.SymbolFlags.Enum) kind='enum'
    let async=false, sig=''
    if (kind==='function'){ const type=checker.getTypeOfSymbolAtLocation(t,decl); const sg=type.getCallSignatures(); sig=sg.map(g=>checker.signatureToString(g,decl,ts.TypeFormatFlags.NoTruncation)).join(' | '); async=/Promise</.test(sig.split('):').slice(-1)[0]) }
    let params=[],ret=''; if(kind==='function'){const type=checker.getTypeOfSymbolAtLocation(t,decl); const g=type.getCallSignatures()[0]; if(g){params=g.getParameters().map(pp=>{const pd=pp.valueDeclaration; return {name:pp.getName(), type:checker.typeToString(checker.getTypeOfSymbolAtLocation(pp,decl),decl,ts.TypeFormatFlags.NoTruncation), optional: !!(pd&&(pd.questionToken||pd.initializer)), rest: !!(pd&&pd.dotDotDotToken)}}); ret=checker.typeToString(g.getReturnType(),decl,ts.TypeFormatFlags.NoTruncation)}}
    out.push({params,ret,module:declFile.replace(/\.ts$/,''),name:s.getName(),kind,async,sig:sig.slice(0,500)})
  }
}
fs.writeFileSync(process.env.OUT, JSON.stringify(out,null,1)); console.log(out.length)
