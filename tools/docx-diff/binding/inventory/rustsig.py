import re,glob,json,collections,sys
def split_top(s,sep=','):
    out=[];depth=0;cur='';i=0
    while i<len(s):
        ch=s[i]
        if ch in '<([{': depth+=1
        elif ch in '>)]}' and not (ch=='>' and i>0 and s[i-1]=='-'): depth-=1
        if ch==sep and depth==0: out.append(cur);cur=''
        else: cur+=ch
        i+=1
    if cur.strip(): out.append(cur)
    return [x.strip() for x in out]
files=[p.replace('\\','/') for p in glob.glob('crates/docx-engine/src/**/*.rs',recursive=True)+glob.glob('crates/omml/src/**/*.rs',recursive=True)+glob.glob('crates/ooxml-pkg/src/**/*.rs',recursive=True)+glob.glob('crates/pptx-engine/src/chart_workbook.rs')]
fns=[]
for p in files:
    t=open(p,encoding='utf8').read()
    lines=t.split('\n')
    for m in re.finditer(r'^( *)(pub(?:\([a-z]+\))? )?(const )?(async )?fn ([a-z_0-9]+)(<[^>(]*>)?\(',t,re.M):
        start=m.end()-1
        # params until matching paren
        depth=0;i=start
        while True:
            c=t[i]
            if c=='(' : depth+=1
            elif c==')':
                depth-=1
                if depth==0: break
            i+=1
        params=t[start+1:i]
        j=i+1
        k=t.find('{',j); sc=t.find(';',j)
        end=k if (sc==-1 or (k!=-1 and k<sc)) else sc
        ret=t[j:end].strip()
        ret=ret[2:].strip() if ret.startswith('->') else ''
        ret=re.sub(r'\s*where[\s\S]*','',ret)
        # doc comment above
        ln=t.count('\n',0,m.start())
        doc=[]; q=ln-1
        while q>=0 and (lines[q].strip().startswith('///') or lines[q].strip().startswith('#[')):
            if lines[q].strip().startswith('///'): doc.append(lines[q].strip()[3:].strip())
            q-=1
        fns.append({'file':p,'name':m.group(5),'vis':(m.group(2) or '').strip(),'indent':len(m.group(1)),'params':[x for x in split_top(params) ],'ret':ret,'doc':' '.join(reversed(doc))})
json.dump(fns,open('../seu-scratch/b4/rustfns.json','w'),indent=1)
print(len(fns))
