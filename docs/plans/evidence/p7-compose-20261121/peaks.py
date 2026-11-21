import json,sys,collections
def mib(s):
    v,u=s.split('/')[0].strip(),None
    import re
    m=re.match(r'([\d.]+)(\w+)',v);n=float(m[1]);u=m[2]
    return n*{'B':1/1048576,'KiB':1/1024,'MiB':1,'GiB':1024}[u]
for f in sys.argv[1:]:
    d=collections.defaultdict(lambda:[0,0,0,[]])
    for l in open(f):
        j=json.loads(l)
        if 'connector' in j['name']: continue
        n=j['name'] if j['name'].startswith('lpc-') else 'app('+j['name'].split('.')[0][:3]+')'
        e=d[n];c=float(j['cpu'].rstrip('%'));m=mib(j['mem'])
        e[0]=max(e[0],c);e[1]=max(e[1],m);e[3].append(m)
    print(f)
    for k,e in sorted(d.items()): print(f"  {k}: peak cpu {e[0]:.1f}% peak mem {e[1]:.1f}MiB median mem {sorted(e[3])[len(e[3])//2]:.1f}MiB samples {len(e[3])}")
