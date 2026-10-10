import { Activity } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlaybackStats } from '@/services/playbackTelemetry';

export function PlaybackInfo({ statsRef, quality, line, engine, onOpenChange }: { onOpenChange: (open: boolean) => void; statsRef: RefObject<PlaybackStats>; quality: string | null; line: string | null; engine: string | null }) {
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [stats, setStats] = useState(statsRef.current);
  useEffect(() => {
    if (!open) return;
    setStats(statsRef.current);
    const timer = setInterval(() => setStats(statsRef.current), 1000);
    return () => clearInterval(timer);
  }, [open, statsRef]);
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (details && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false;
      }
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    return () => document.removeEventListener('pointerdown', dismissOutside, true);
  }, [open]);
  return <details ref={detailsRef} className="playback-info" data-tauri-drag-region="false" onToggle={e => { setOpen(e.currentTarget.open); onOpenChange(e.currentTarget.open); }}>
    <summary aria-label="播放信息" title="播放信息"><Activity size={17} /></summary>
    <div className="playback-info-panel">
      <strong>播放信息</strong>
      <dl>
        <div><dt>实际画面</dt><dd>{stats.width && stats.height ? `${stats.width} × ${stats.height}` : '等待视频'}</dd></div>
        <div><dt>流标注帧率</dt><dd>{stats.sourceFps ? `${stats.sourceFps} 帧/秒` : '流未提供'}</dd></div>
        <div><dt>播放帧率</dt><dd>{stats.playbackFps ? `约 ${stats.playbackFps} 帧/秒` : '测量中'}</dd></div>
        <div><dt>平台画质</dt><dd>{quality || '待确认'}</dd></div>
        <div><dt>视频编码</dt><dd>{stats.codec || '待确认'}</dd></div>
        <div><dt>线路</dt><dd>{line || '自动'}</dd></div>
        <div><dt>缓冲</dt><dd>{stats.bufferedSeconds.toFixed(1)} 秒</dd></div>
        <div><dt>丢帧</dt><dd>{stats.droppedFrames} / {stats.totalFrames}</dd></div>
        <div><dt>播放方式</dt><dd>{engine || '准备中'}</dd></div>
      </dl>
      <p>分辨率来自实际视频。标注帧率由直播源提供，播放帧率为实测呈现速度。</p>
    </div>
  </details>;
}
