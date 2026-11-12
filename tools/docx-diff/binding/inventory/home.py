import json,re,glob,os,collections
d=json.load(open('../seu-scratch/b4/index-exports.json'))
# rust homes by doc comment
doc=collections.defaultdict(list)
for p in glob.glob('crates/docx-engine/src/**/*.rs',recursive=True)+glob.glob('crates/omml/src/**/*.rs',recursive=True)+glob.glob('crates/ooxml-pkg/src/**/*.rs',recursive=True)+glob.glob('crates/jscompat/src/**/*.rs',recursive=True):
    p=p.replace('\\','/')
    for m in re.finditer(r'^\s*///\s*`([A-Za-z_][A-Za-z0-9_]*)[`(:]',open(p,encoding='utf8',errors='ignore').read(),re.M):
        doc[m.group(1)].append(p.replace('crates/docx-engine/src/','de/'))
# group map from calls/mod.rs
modrs=open('crates/office-wasm/src/calls/mod.rs',encoding='utf8').read()
g2m={m.group(1):m.group(2) for m in re.finditer(r'"(\w+)" => Some\((\w+)::dispatch',modrs)}
m2g={v:k for k,v in g2m.items()}
routes=collections.defaultdict(list)
for p in glob.glob('crates/office-wasm/src/calls/**/*.rs',recursive=True):
    p=p.replace('\\','/'); t=open(p,encoding='utf8').read()
    mod=os.path.basename(p)[:-3]
    parent=os.path.basename(os.path.dirname(p))
    grp=None
    if parent=='save': grp='save'
    elif parent=='parse': grp='parse'
    elif mod in m2g: grp=m2g[mod]
    for m in re.finditer(r'^\s*"([A-Za-z0-9_]+)"\s*(?:=>|\|)',t,re.M):
        routes[m.group(1)].append(grp or mod)
props=open('crates/office-wasm/src/props.rs',encoding='utf8').read()
for m in re.finditer(r'^\s*"([A-Za-z0-9_]+)"\s*(?:=>|\|)',props,re.M): routes[m.group(1)].append('props')
res=[]
for e in d:
    if e['kind'] not in('function','const'): continue
    n=e['name']
    res.append({**e,'rust':sorted(set(doc.get(n,[]))),'route':sorted(set(routes.get(n,[])))})
json.dump(res,open('../seu-scratch/b4/home.json','w'),indent=1)
nohome=[r['name'] for r in res if not r['rust']]
noroute=[r['name'] for r in res if r['kind']=='function' and not r['route']]
print('fn',sum(r['kind']=='function' for r in res),'no rust doc',len(nohome),nohome)
print('fn no (f) route',len(noroute),noroute)
