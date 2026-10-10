#!/usr/bin/env python3
"""Serve the real static UI with fictional, local-only data for documentation.
Run after pnpm -C web build. Not included in the application or release bundle.
"""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import json

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'web/out'
NAMES = ['北岸电台', '一只纸飞机', '山间画室', '阿白的游戏角', '慢慢写代码', '周末放映室', '夜航音乐台']
TITLES = ['把窗外的风景，留给今天', '下一站，去远一点的地方', '一笔一画，慢慢来', '今晚一起过关', '做一点喜欢的小东西', '下次开播见', '把好听的歌留到晚上']
PLATFORMS = ['BILIBILI', 'DOUYIN', 'HUYA', 'DOUYU', 'BILIBILI', 'DOUYIN', 'HUYA']
COLORS = ['#B6C8D5', '#DCCBB5', '#C7CCD0', '#A6B4C4', '#D4C7B9', '#C4C9CE', '#BCC3CC']


def art(index, avatar=False):
    c = COLORS[index % len(COLORS)]
    if avatar:
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" rx="50" fill="{c}"/><text x="50" y="64" text-anchor="middle" font-size="43" fill="#34404B" font-family="PingFang SC,sans-serif">{NAMES[index][0]}</text></svg>'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <rect width="640" height="360" fill="{c}"/>
      <circle cx="480" cy="87" r="38" fill="#F3EBDB"/>
      <path d="M0 280L165 105 370 310 545 186 640 285V360H0Z" fill="#647787"/>
      <path d="M0 304Q140 232 330 300T640 282V360H0Z" fill="#3F5361"/>
      <path d="M0 337Q210 279 415 334T640 320V360H0Z" fill="#283B48"/>
      <text x="30" y="45" fill="#34404B" font-family="-apple-system,sans-serif" font-size="13" letter-spacing="3">QTV · DEMO {index+1:02}</text>
    </svg>'''


def boot(theme):
    follows = [dict(id=str(10001+i), platform=PLATFORMS[i], nickname=NAMES[i], roomTitle=TITLES[i], avatarUrl=f'/demo/avatar/{i}.svg', coverUrl=f'/demo/cover/{i}.svg', liveStatus='LIVE' if i<3 else 'OFFLINE', currentRoomId=str(10001+i), hidden=i==6, lastCheckedAt=0) for i in range(7)]
    return '''<script>
    // Explicit documentation fixture: all data is fictional, all platform IPC stays local.
    const demo = ''' + json.dumps(follows, ensure_ascii=False) + ''';
    demo.forEach(s => { s.avatarUrl = location.origin+s.avatarUrl; s.coverUrl=location.origin+s.coverUrl; });
    localStorage.setItem('followedStreamers',JSON.stringify(demo));
    localStorage.setItem('followListOrder',JSON.stringify(demo.map(data=>({type:'streamer',data}))));
    localStorage.setItem('followFolders','[]');
    localStorage.setItem('theme_preference', '''+json.dumps(theme)+''');
    const callbacks = {};
    window.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'}, currentWebview:{label:'main'}},
      transformCallback: (callback)=>{const id=Math.floor(Math.random()*1e9);callbacks[id]=callback;return id;},
      unregisterCallback: id=>delete callbacks[id],
      invoke: async (command,args={})=>{
        if(command==='start_static_proxy_server') return location.origin;
        if(command==='plugin:os|platform') return 'macos';
        if(command==='plugin:event|listen') return 1;
        if(command==='plugin:window|is_maximized') return false;
        if(command==='plugin:window|scale_factor') return 1;
        if(command==='plugin:window|inner_size') return {width:1200,height:675};
        if(command==='lan_sync_status') return null;
        const id=args.roomId||args.payload?.args?.room_id_str;
        const row=demo.find(s=>s.id===id);
        if(row) return {nickname:row.nickname,anchor_name:row.nickname,room_name:row.roomTitle,title:row.roomTitle,avatar_url:row.avatarUrl,avatar:row.avatarUrl,cover_url:row.coverUrl,show_status:row.liveStatus==='LIVE'?1:2,video_loop:0,is_live:row.liveStatus==='LIVE',status:row.liveStatus==='LIVE'?(row.platform==='DOUYIN'?2:1):0};
        return null;
      }
    };
    </script>'''


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(OUT), **kwargs)
    def log_message(self, *args): pass
    def respond(self, body, mime):
        data=body.encode(); self.send_response(200); self.send_header('Content-Type',mime); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        u=urlparse(self.path); query=parse_qs(u.query)
        if u.path == '/':
            theme=query.get('theme',['dark'])[0]
            html=(OUT/'index.html').read_text().replace('<head>','<head>'+boot(theme),1)
            return self.respond(html,'text/html; charset=utf-8')
        if u.path == '/image':
            p=urlparse(query.get('url',[''])[0]); self.path=p.path; u=p
        if u.path.startswith('/demo/'):
            i=int(Path(u.path).stem); return self.respond(art(i,'/avatar/' in u.path),'image/svg+xml')
        super().do_GET()

if __name__=='__main__':
    print('Documentation preview: http://127.0.0.1:4197/?theme=dark',flush=True)
    ThreadingHTTPServer(('127.0.0.1',4197),Handler).serve_forever()
