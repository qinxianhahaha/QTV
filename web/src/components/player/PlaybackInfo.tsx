import { Activity, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlaybackStats } from '@/services/playbackTelemetry';
import { EMPTY_TRAFFIC, formatTrafficBytes, mediaTrafficUrl, watchMediaTraffic } from '@/services/mediaTraffic';

export function PlaybackInfo({ statsRef, mediaUrl, quality, line, engine, onOpenChange }: { onOpenChange: (open: boolean) => void; statsRef: RefObject<PlaybackStats>; mediaUrl: string | null; quality: string | null; line: string | null; engine: string | null }) {
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [stats, setStats] = useState(statsRef.current);
  const [traffic, setTraffic] = useState(EMPTY_TRAFFIC);
  const trafficUrl = mediaTrafficUrl(mediaUrl);
  useEffect(() => {
    setTraffic({ ...EMPTY_TRAFFIC });
    if (!open || !trafficUrl) return;
    return watchMediaTraffic(trafficUrl, setTraffic);
  }, [open, trafficUrl]);
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
    <summary aria-label="播放信息" title="查看实时网速、分辨率和播放详情"><Activity size={16} /><span>播放信息</span></summary>
    <div className="playback-info-panel">
      <div className="playback-info-heading"><strong>播放信息</strong><button type="button" aria-label="关闭播放信息" onClick={() => { if (detailsRef.current) detailsRef.current.open = false; }}><X size={15} /></button></div>
      <div className="playback-network">
        <span>实时接收速度</span>
        <b>{formatTrafficBytes(traffic.bytesPerSecond, true)}</b>
        <small>{!trafficUrl ? '当前播放通道不支持流量统计' : traffic.totalBytes === null ? '等待流量数据…' : traffic.bytesPerSecond === null ? '采样中…' : '每秒刷新 · 仅统计当前直播'}</small>
      </div>
      <dl>
        <div><dt>近 10 秒平均</dt><dd>{formatTrafficBytes(traffic.averageBytesPerSecond, true)}</dd></div>
        <div><dt>平均网络占用</dt><dd>{traffic.averageBytesPerSecond === null ? '—' : `${(traffic.averageBytesPerSecond * 8 / 1e6).toFixed(2)} Mbps`}</dd></div>
        <div><dt>预计每小时流量</dt><dd>{formatTrafficBytes(traffic.averageBytesPerSecond === null ? null : traffic.averageBytesPerSecond * 3600)}</dd></div>
        <div><dt>当前连接已接收</dt><dd>{formatTrafficBytes(traffic.totalBytes)}</dd></div>
        <div className="playback-info-divider"><dt>分辨率</dt><dd>{stats.width && stats.height ? `${stats.width} × ${stats.height}` : '等待视频'}</dd></div>
        <div><dt>流标注帧率</dt><dd>{stats.sourceFps ? `${stats.sourceFps} 帧/秒` : '流未提供'}</dd></div>
        <div><dt>播放帧率</dt><dd>{stats.playbackFps ? `约 ${stats.playbackFps} 帧/秒` : '测量中'}</dd></div>
        <div><dt>平台画质</dt><dd>{quality || '待确认'}</dd></div>
        <div><dt>视频编码</dt><dd>{stats.codec || '待确认'}</dd></div>
        <div><dt>线路</dt><dd>{line || '自动'}</dd></div>
        <div><dt>缓冲</dt><dd>{stats.bufferedSeconds.toFixed(1)} 秒</dd></div>
        <div><dt>丢帧</dt><dd>{stats.droppedFrames} / {stats.totalFrames}</dd></div>
        <div><dt>播放方式</dt><dd>{engine || '准备中'}</dd></div>
      </dl>
      <p>1 MB/s = 8 Mbps。直播分段加载时网速会起伏，判断带宽可参考近 10 秒平均值；每小时流量按此估算。统计含音视频及播放列表，不含弹幕、封面和网络协议开销。</p>
    </div>
  </details>;
}
