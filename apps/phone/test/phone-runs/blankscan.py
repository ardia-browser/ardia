import sys, subprocess, statistics
v=sys.argv[1]; W,H=108,240
p=subprocess.run([sys.argv[2],'-v','error','-i',v,'-vf',f'scale={W}:{H},format=gray','-vsync','0','-f','rawvideo','-'],capture_output=True).stdout
ts=subprocess.run([sys.argv[2],'-v','info','-i',v,'-vf','showinfo','-vsync','0','-f','null','-'],capture_output=True,text=True).stderr
t=[float(x.split('pts_time:')[1].split()[0]) for x in ts.splitlines() if 'pts_time:' in x]
n=len(p)//(W*H); rows=[]
for i in range(n):
    f=p[i*W*H:(i+1)*W*H]
    top=f[W*12:W*100]
    rows.append((t[i] if i<len(t) else -1, statistics.pstdev(top), sum(top)/len(top)))
blank=[r for r in rows if r[1]<4]
print(v, n,'frames;', len(blank),'frames with a flat top area')
runs=[];cur=[]
for r in blank:
    if cur and r[0]-cur[-1][0]>0.2: runs.append(cur); cur=[]
    cur.append(r)
if cur: runs.append(cur)
for c in runs: print(f'  {c[0][0]:.2f}-{c[-1][0]:.2f}s  {len(c)} frames  mean {c[0][2]:.0f} std {c[0][1]:.1f}')
