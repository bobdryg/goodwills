import React, { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import JSZip from "jszip";

type ActiveMenu = "none" | "presets" | "share" | "contest" | "nature" | "music";

type QrPayload = {
  v: string;
  id: string;
  createdAt: string;
  title: string;
  volumes: { big: number; small: number; master: number };
};

type MintJson = {
  signature: string;
  v: string;
  id: string;
  createdAt: string;
  mood: string;
  intention: string | null;
  duration: number;
  volumes: { big: number; small: number; master: number } | null;
  qr: string | null;
  source: {
    webmFileName: string;
    webmSize: number;
    webmDuration: number;
    sha256: string; // hex
  };
};

type MintPack = {
  fileName: string;
  data: MintJson;
  videoBlob: Blob | null;
};

const RECORD_LIMIT_SEC = 100;

function hexFromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const ab = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return hexFromBuffer(digest);
}

const Studio: React.FC = () => {
  // ===== UI state =====
  const [sleepMode, setSleepMode] = useState(false);
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>("none");
  const [isMobile, setIsMobile] = useState(
  window.matchMedia("(max-width: 768px)").matches
  );

  const [showMobileMenu, setShowMobileMenu] = useState(false);
  
  // My rituals (.mint packs)
  const ritualsMintInputRef = useRef<HTMLInputElement | null>(null);
  const [showMyRituals, setShowMyRituals] = useState(false);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [packs, setPacks] = useState<MintPack[]>([]);
  const [selectedPack, setSelectedPack] = useState<MintPack | null>(null);
  const [selectedPackVideoUrl, setSelectedPackVideoUrl] = useState<string | null>(null);

  // Mint flow (from saved WebM file)
  const mintFileInputRef = useRef<HTMLInputElement | null>(null);
  const [showMintModal, setShowMintModal] = useState(false);
  const [mintFile, setMintFile] = useState<File | null>(null);
  const [mintPreviewUrl, setMintPreviewUrl] = useState<string | null>(null);
  const [mintDuration, setMintDuration] = useState<number>(0);

  // Mint source QR (read from WebM during pick)
  const [mintQrPayload, setMintQrPayload] = useState<QrPayload | null>(null);
  const [mintQrText, setMintQrText] = useState<string | null>(null);

  // Mint fields (entered at mint)
  const [mood, setMood] = useState<string>("calm");
  const [intention, setIntention] = useState<string>("");

  // Listen-only (no recording)

  // ===== Video refs & sources =====
  const bgRef = useRef<HTMLVideoElement | null>(null);
  const muRef = useRef<HTMLVideoElement | null>(null);

  const [bgSrc, setBgSrc] = useState<string | null>(null);
  const [muSrc, setMuSrc] = useState<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);

  // Glue: keep relative offset between BIG and SMALL when user drags timelines
  const [isGlued, setIsGlued] = useState(false);
  // offsetSec = muTime - bgTime (captured when glue is enabled)
  const glueOffsetSecRef = useRef(0);
  // loop-aware glue sync (keeps offset even when one track loops earlier)
  const prevBgTimeRef = useRef<number | null>(null);
  const prevMuTimeRef = useRef<number | null>(null);
  const glueSyncGuardRef = useRef(false);

  const [bgProgress, setBgProgress] = useState(0);
  const [muProgress, setMuProgress] = useState(0);

  // ===== Faders =====
  const [bgVol, setBgVol] = useState(0.7);
  const [muVol, setMuVol] = useState(0.3);
  const [masterVol, setMasterVol] = useState(0.4);

  // ===== WebAudio graph =====
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bgSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const muSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const bgGainRef = useRef<GainNode | null>(null);
  const muGainRef = useRef<GainNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);

  // ===== Recording refs =====
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recIntervalRef = useRef<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recTime, setRecTime] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const recordAudioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recordOutStreamRef = useRef<MediaStream | null>(null);

  // ===== QR prepared at record start, burned into video =====
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const qrDataUrlRef = useRef<string | null>(null);
  const qrPayloadRef = useRef<QrPayload | null>(null);

  // ===== Save panel (post-record) =====
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [pendingRecordedBlob, setPendingRecordedBlob] = useState<Blob | null>(null);
  const [pendingRecordedUrl, setPendingRecordedUrl] = useState<string | null>(null);
  const [pendingQrPng, setPendingQrPng] = useState<string | null>(null);
  const [pendingQrPayload, setPendingQrPayload] = useState<QrPayload | null>(null);

  // ---------------- helpers ----------------
  const toggleSleep = () => setSleepMode(v => !v);
  const toggleMenu = (menu: ActiveMenu) => setActiveMenu(prev => (prev === menu ? "none" : menu));

  const ensureAudioContext = () => {
    if (audioCtxRef.current) return;

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    // when using WebAudio, keep media elements at full volume
    if (bgRef.current) bgRef.current.volume = 1;
    if (muRef.current) muRef.current.volume = 1;

    // BIG
    bgSourceRef.current = ctx.createMediaElementSource(bgRef.current!);
    bgGainRef.current = ctx.createGain();
    bgGainRef.current.gain.value = bgVol;

    // MASTER
    masterGainRef.current = ctx.createGain();
    masterGainRef.current.gain.value = masterVol;

    bgSourceRef.current.connect(bgGainRef.current).connect(masterGainRef.current);
    masterGainRef.current.connect(ctx.destination);
  };

  const ensureMiniConnected = () => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (!muRef.current) return;
    if (muSourceRef.current) return;

    muSourceRef.current = ctx.createMediaElementSource(muRef.current);
    muGainRef.current = ctx.createGain();
    muGainRef.current.gain.value = muVol;

    muSourceRef.current.connect(muGainRef.current).connect(masterGainRef.current!);
  };

  useEffect(() => {
    if (!audioCtxRef.current) {
      if (bgRef.current) bgRef.current.volume = bgVol * masterVol;
      if (muRef.current) muRef.current.volume = muVol * masterVol;
      return;
    }
    if (bgGainRef.current) bgGainRef.current.gain.value = bgVol;
    if (muGainRef.current) muGainRef.current.gain.value = muVol;
    if (masterGainRef.current) masterGainRef.current.gain.value = masterVol;
  }, [bgVol, muVol, masterVol]);
 
  useEffect(() => {
  const mq = window.matchMedia("(max-width: 768px)");

  const handler = (e: MediaQueryListEvent) => {
    setIsMobile(e.matches);

    // при выходе из мобилки закрываем мобильные оверлеи
    if (!e.matches) {
      setShowMobileMenu(false);
    }
  };

  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}, []);

  // ---------------- QR helpers ----------------
  const isGoodwillsQRPayload = (txt: string) => {
    try {
      const obj = JSON.parse(txt);
      return (
        obj &&
        typeof obj === "object" &&
        typeof obj.id === "string" &&
        obj.id.startsWith("gw-") &&
        typeof obj.createdAt === "string" &&
        obj.volumes &&
        typeof obj.volumes.big === "number" &&
        typeof obj.volumes.small === "number" &&
        typeof obj.volumes.master === "number"
      );
    } catch {
      return false;
    }
  };

  const scanGoodwillsQrFromFile = async (file: File) => {
    const url = URL.createObjectURL(file);

    try {
      const v = document.createElement("video");
      v.src = url;
      v.muted = true;
      v.playsInline = true;

      await new Promise<void>((resolve, reject) => {
        v.onloadedmetadata = () => resolve();
        v.onerror = () => reject(new Error("Video load error"));
      });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false as const };

      canvas.width = v.videoWidth || 1280;
      canvas.height = v.videoHeight || 720;

      const times = [0.15, 0.35, 0.6, 0.9, 1.2, 1.6, 2.0].filter(t => t < (v.duration || 9999));

      for (const t of times) {
        await new Promise<void>(resolve => {
          v.currentTime = t;
          v.onseeked = () => resolve();
        });

        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

        // 1) crop top-left where QR is
        const cropW = Math.round(canvas.width * 0.32);
        const cropH = Math.round(canvas.height * 0.32);
        const img1 = ctx.getImageData(0, 0, cropW, cropH);
        const code1 = jsQR(img1.data, img1.width, img1.height, { inversionAttempts: "attemptBoth" });
        if (code1?.data && isGoodwillsQRPayload(code1.data)) {
          const payload = JSON.parse(code1.data) as QrPayload;
          return { ok: true as const, payloadText: code1.data, payload };
        }

        // 2) fallback: full frame
        const img2 = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code2 = jsQR(img2.data, img2.width, img2.height, { inversionAttempts: "attemptBoth" });
        if (code2?.data && isGoodwillsQRPayload(code2.data)) {
          const payload = JSON.parse(code2.data) as QrPayload;
          return { ok: true as const, payloadText: code2.data, payload };
        }
      }

      return { ok: false as const };
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  // ---------------- .mint pack helpers ----------------
  const readMintPackFile = async (file: File): Promise<MintPack> => {
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    const mintEntry = zip.file("mint.json");
    if (!mintEntry) throw new Error("mint.json not found");
    const mintText = await mintEntry.async("string");
    const data = JSON.parse(mintText) as MintJson;

    const videoEntry = zip.file("video.webm");
    const videoBlob = videoEntry ? await videoEntry.async("blob") : null;

    return { fileName: file.name, data, videoBlob };
  };

  const openMyRituals = () => {
    setSelectedPack(null);
    setShowMyRituals(true);
    ritualsMintInputRef.current?.click();
  };

  const closeMyRituals = () => {
    setShowMyRituals(false);
    setSelectedPack(null);
    if (selectedPackVideoUrl) URL.revokeObjectURL(selectedPackVideoUrl);
    setSelectedPackVideoUrl(null);
  };

  const handleRitualMintFilesPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    try {
      const loaded: MintPack[] = [];
      for (const f of files) {
        try {
          loaded.push(await readMintPackFile(f));
        } catch (err) {
          console.warn("Failed to read pack", f.name, err);
        }
      }

      loaded.sort((a, b) => (b.data.createdAt || "").localeCompare(a.data.createdAt || ""));
      setPacks(loaded);
    } finally {
      e.target.value = "";
    }
  };

  const openPack = async (p: MintPack) => {
    setSelectedPack(p);

    if (selectedPackVideoUrl) {
      URL.revokeObjectURL(selectedPackVideoUrl);
      setSelectedPackVideoUrl(null);
    }

    if (p.videoBlob) {
      setSelectedPackVideoUrl(URL.createObjectURL(p.videoBlob));
    }
  };

  // ---------------- global transport ----------------
  const stopRecording = () => {
    if (recIntervalRef.current) {
      clearInterval(recIntervalRef.current);
      recIntervalRef.current = null;
    }
    if (recordTimerRef.current) {
      clearTimeout(recordTimerRef.current);
      recordTimerRef.current = null;
    }

    bgRef.current?.pause();
    muRef.current?.pause();
    setIsPlaying(false);

    const rec = recorderRef.current;
    if (rec && rec.state === "recording") rec.stop();
    else setIsRecording(false);
  };

  const handleGlobalPlayPause = () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    ensureAudioContext();
    ensureMiniConnected();

    const bg = bgRef.current;
    const mu = muRef.current;

    const shouldPlay = !isPlaying;
    if (shouldPlay) {
      bg?.play();
      mu?.play();
      setIsPlaying(true);
    } else {
      bg?.pause();
      mu?.pause();
      setIsPlaying(false);
    }
  };

  const handleGlobalStop = () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    const bg = bgRef.current;
    const mu = muRef.current;

    if (bg) {
      bg.pause();
      bg.currentTime = 0;
    }
    if (mu) {
      mu.pause();
      mu.currentTime = 0;
    }

    setIsPlaying(false);
    setBgProgress(0);
    setMuProgress(0);
    setRecTime(0);
  };

  // ---------------- timeline handlers ----------------
  const wrapTime = (t: number, dur: number) => {
    if (!Number.isFinite(dur) || dur <= 0) return 0;
    const m = t % dur;
    return m < 0 ? m + dur : m;
  };


  const handleBgTimeUpdate = () => {
    const bg = bgRef.current;
    if (!bg || !bg.duration) return;

    // normal progress
    setBgProgress(bg.currentTime / bg.duration);

    // Loop-aware glue sync: when one track loops, advance the other by the same "through-the-end" delta.
    if (!isGlued || !isPlaying || isRecording) {
      prevBgTimeRef.current = bg.currentTime;
      return;
    }
    if (glueSyncGuardRef.current) {
      prevBgTimeRef.current = bg.currentTime;
      return;
    }

    const prev = prevBgTimeRef.current;
    prevBgTimeRef.current = bg.currentTime;
    if (prev == null) return;

    // detect a loop (a sudden jump backwards)
    if (bg.currentTime < prev - 0.5) {
      const delta = (bg.duration - prev) + bg.currentTime;

      const mu = muRef.current;
      if (mu && mu.duration) {
        glueSyncGuardRef.current = true;
        const next = wrapTime((mu.currentTime || 0) + delta, mu.duration);
        mu.currentTime = next;
        setMuProgress(next / mu.duration);
        glueSyncGuardRef.current = false;
      }
    }
  };
  const handleMuTimeUpdate = () => {
    const mu = muRef.current;
    if (!mu || !mu.duration) return;

    setMuProgress(mu.currentTime / mu.duration);

    if (!isGlued || !isPlaying || isRecording) {
      prevMuTimeRef.current = mu.currentTime;
      return;
    }
    if (glueSyncGuardRef.current) {
      prevMuTimeRef.current = mu.currentTime;
      return;
    }

    const prev = prevMuTimeRef.current;
    prevMuTimeRef.current = mu.currentTime;
    if (prev == null) return;

    if (mu.currentTime < prev - 0.5) {
      const delta = (mu.duration - prev) + mu.currentTime;

      const bg = bgRef.current;
      if (bg && bg.duration) {
        glueSyncGuardRef.current = true;
        const next = wrapTime((bg.currentTime || 0) + delta, bg.duration);
        bg.currentTime = next;
        setBgProgress(next / bg.duration);
        glueSyncGuardRef.current = false;
      }
    }
  };
  const handleBgTimelineChange = (value: number) => {
    const v = bgRef.current;
    if (!v || !v.duration) return;
    const tBg = value * v.duration;
    v.currentTime = tBg;
    setBgProgress(value);

    // When glued, keep the offset that was set at glue time.
    if (isGlued) {
      const m = muRef.current;
      if (m && m.duration) {
        const tMu = tBg + glueOffsetSecRef.current;
        const wrapped = wrapTime(tMu, m.duration);
        m.currentTime = wrapped;
        setMuProgress(wrapped / m.duration);
      }
    }
  };
  const handleMuTimelineChange = (value: number) => {
    const v = muRef.current;
    if (!v || !v.duration) return;
    const tMu = value * v.duration;
    v.currentTime = tMu;
    setMuProgress(value);

    // When glued, keep the offset that was set at glue time.
    if (isGlued) {
      const b = bgRef.current;
      if (b && b.duration) {
        const tBg = tMu - glueOffsetSecRef.current;
        const wrapped = wrapTime(tBg, b.duration);
        b.currentTime = wrapped;
        setBgProgress(wrapped / b.duration);
      }
    }
  };

  const toggleGlue = () => {
    // Glue makes sense only when SMALL track exists
    if (!muSrc) return;
    setIsGlued(prev => {
      const next = !prev;
      if (next) {
        const bg = bgRef.current;
        const mu = muRef.current;
        if (bg && mu) {
          glueOffsetSecRef.current = (mu.currentTime || 0) - (bg.currentTime || 0);
        }
      }
      return next;
    });
  };

  // ---------------- big/mini player buttons ----------------
  const handleBgPlayPause = () => {
    if (isRecording) return;
    ensureAudioContext();
    ensureMiniConnected();
    const v = bgRef.current;
    if (!v) return;

    if (v.paused) {
      v.play();
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
  };

  const handleBgStop = () => {
    if (isRecording) return;
    const v = bgRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
    setIsPlaying(false);
    setBgProgress(0);
  };

  const handleMuPlayPause = () => {
    if (isRecording) return;
    ensureAudioContext();
    ensureMiniConnected();
    const v = muRef.current;
    if (!v) return;

    if (v.paused) {
      v.play();
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
  };

  const handleMuStop = () => {
    if (isRecording) return;
    const v = muRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
    setMuProgress(0);
  };

  // ---------------- file loaders ----------------
  const handleUploadNature = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    setBgSrc(url);
    setBgProgress(0);
    setIsPlaying(false);
    setActiveMenu("none");
    setIsGlued(false);
  };

  const handleUploadMusic = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    setMuSrc(url);
    setMuProgress(0);
    setIsPlaying(false);
    setActiveMenu("none");
    setIsGlued(false);
  };

  // ---------------- presets ----------------
  const BASE = import.meta.env.BASE_URL; // на Pages это "/goodwills/"

  const applyPreset = (name: string) => {
    setIsGlued(false);
    setActiveMenu("none");
    switch (name) {
      case "Stormbound":
       setBgSrc(`${BASE}presets/storm_nature.mp4`);
       setMuSrc(`${BASE}presets/storm_music.mp4`);
        break;
      case "SunsetBurn":
        setBgSrc(`${BASE}presets/sunset_nature.mp4`);
        setMuSrc(`${BASE}presets/sunset_music.mp4`);
        break;
      case "VoidStare":
        setBgSrc(`${BASE}presets/void_nature.mp4`);
        setMuSrc(`${BASE}presets/void_music.mp4`);
        break;
      default:
        return;
    }
    setBgProgress(0);
    setMuProgress(0);
    setIsPlaying(false);
  };

  // ---------------- recording ----------------
  const waitForVideoReady = (v: HTMLVideoElement, timeoutMs = 2500) => {
    return new Promise<boolean>(resolve => {
      const readyNow = v.videoWidth > 0 && v.videoHeight > 0;
      if (readyNow) return resolve(true);

      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(ok);
      };

      const onReady = () => finish(v.videoWidth > 0 && v.videoHeight > 0);

      const cleanup = () => {
        v.removeEventListener("loadedmetadata", onReady);
        v.removeEventListener("loadeddata", onReady);
        v.removeEventListener("canplay", onReady);
      };

      v.addEventListener("loadedmetadata", onReady);
      v.addEventListener("loadeddata", onReady);
      v.addEventListener("canplay", onReady);

      window.setTimeout(() => finish(false), timeoutMs);
    });
  };

  const startRecording = async () => {
    const ctx = audioCtxRef.current;
    const master = masterGainRef.current;
    const bgVideo = bgRef.current;
    if (!ctx || !master || !bgVideo) return;

    let canvas = canvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvasRef.current = canvas;
    }
    const c2d = canvas.getContext("2d");
    if (!c2d) return;

    await waitForVideoReady(bgVideo, 2500);

    canvas.width = bgVideo.videoWidth || 1280;
    canvas.height = bgVideo.videoHeight || 720;

    try {
      c2d.drawImage(bgVideo, 0, 0, canvas.width, canvas.height);
    } catch {}

    // prepare QR payload
    try {
      const createdAt = new Date().toISOString();
      const id = `gw-${Date.now()}`;
      const title = `GOODWILLS_${createdAt.replace(/[:.]/g, "-")}`;

      const payload: QrPayload = {
        v: "0.1",
        id,
        createdAt,
        title,
        volumes: { big: bgVol, small: muVol, master: masterVol },
      };

      qrPayloadRef.current = payload;

      const qrCanvas = document.createElement("canvas");
      await QRCode.toCanvas(qrCanvas, JSON.stringify(payload), { margin: 0, width: 256 });
      qrCanvasRef.current = qrCanvas;

      try {
        qrDataUrlRef.current = qrCanvas.toDataURL("image/png");
      } catch {
        qrDataUrlRef.current = null;
      }
    } catch (e) {
      console.warn("QR generation failed:", e);
      qrCanvasRef.current = null;
      qrDataUrlRef.current = null;
      qrPayloadRef.current = null;
    }

    const fps = 30;
    const canvasStream = canvas.captureStream(fps);

    const audioDest = ctx.createMediaStreamDestination();
    recordAudioDestRef.current = audioDest;
    master.connect(audioDest);

    const outStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()]);
    recordOutStreamRef.current = outStream;

    recordedChunksRef.current = [];

    const mimeCandidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = mimeCandidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(outStream, mimeType ? { mimeType } : undefined);
    recorderRef.current = rec;

    rec.ondataavailable = e => {
      if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
    };

    rec.onstop = () => {
      if (drawRafRef.current) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }

      const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);

      setPendingRecordedBlob(blob);
      setPendingRecordedUrl(url);
      setPendingQrPng(qrDataUrlRef.current);
      setPendingQrPayload(qrPayloadRef.current);
      setShowSavePanel(true);

      setIsRecording(false);
      setRecTime(0);
      recorderRef.current = null;
      recordedChunksRef.current = [];

      if (recIntervalRef.current) {
        clearInterval(recIntervalRef.current);
        recIntervalRef.current = null;
      }
      if (recordTimerRef.current) {
        clearTimeout(recordTimerRef.current);
        recordTimerRef.current = null;
      }

      try {
        if (recordAudioDestRef.current) masterGainRef.current?.disconnect(recordAudioDestRef.current);
      } catch {}
      recordAudioDestRef.current = null;

      try {
        recordOutStreamRef.current?.getTracks().forEach(t => t.stop());
      } catch {}
      recordOutStreamRef.current = null;
    };

    const draw = () => {
      try {
        c2d.drawImage(bgVideo, 0, 0, canvas!.width, canvas!.height);

        // watermark
        c2d.save();
        c2d.globalAlpha = 0.35;
        c2d.fillStyle = "#e5e7eb";
        const fontPx = Math.round(canvas!.width * 0.018);
        c2d.font = `${fontPx}px Inter, sans-serif`;
        c2d.textBaseline = "top";
        c2d.fillText("GOODWILLS.NFT", 24, 20);
        c2d.restore();

        // QR under watermark (bigger + quiet zone + no smoothing)
        const qrC = qrCanvasRef.current;
        if (qrC) {
          const fontPx = Math.round(canvas!.width * 0.018);
          const x0 = 24;
          const y0 = 20 + fontPx + 10;
          const s = Math.round(canvas!.width * 0.15);
          const pad = Math.round(s * 0.06);

          c2d.save();
          c2d.globalAlpha = 1;
          c2d.fillStyle = "#ffffff";
          c2d.fillRect(x0 - pad, y0 - pad, s + pad * 2, s + pad * 2);

          const prevSmooth = (c2d as any).imageSmoothingEnabled;
          (c2d as any).imageSmoothingEnabled = false;
          c2d.drawImage(qrC, x0, y0, s, s);
          (c2d as any).imageSmoothingEnabled = prevSmooth;
          c2d.restore();
        }

        // PiP
        const muVideo = muRef.current;
        if (muVideo && muVideo.videoWidth > 0 && muVideo.videoHeight > 0) {
          const pipW = canvas!.width * 0.32;
          const pipH = pipW * (9 / 16);
          const margin = Math.round(canvas!.width * 0.02);
          const x = canvas!.width - pipW - margin;
          const y = canvas!.height - pipH - margin;

          c2d.save();
          c2d.shadowColor = "rgba(0,0,0,0.6)";
          c2d.shadowBlur = 18;
          c2d.shadowOffsetY = 6;
          c2d.drawImage(muVideo, x, y, pipW, pipH);
          c2d.restore();
        }
      } catch {}

      drawRafRef.current = requestAnimationFrame(draw);
    };
    draw();

    rec.start();
    setIsRecording(true);
    setRecTime(0);

    if (recIntervalRef.current) clearInterval(recIntervalRef.current);
    recIntervalRef.current = window.setInterval(() => {
      setRecTime(t => {
        if (t + 1 >= RECORD_LIMIT_SEC) {
          stopRecording();
          return 0;
        }
        return t + 1;
      });
    }, 1000);

    if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
    recordTimerRef.current = window.setTimeout(() => stopRecording(), RECORD_LIMIT_SEC * 1000);
  };

  const handleGlobalRec = () => {

    if (isRecording) {
      stopRecording();
      return;
    }

    ensureAudioContext();
    ensureMiniConnected();

    if (isPlaying) {
      bgRef.current?.pause();
      muRef.current?.pause();
      setIsPlaying(false);
    }

    void startRecording();

    bgRef.current?.play();
    muRef.current?.play();
    setIsPlaying(true);
  };

  // ---------------- save panel actions ----------------
  const handleSaveConfirm = () => {
    if (!pendingRecordedUrl || !pendingRecordedBlob) {
      setShowSavePanel(false);
      return;
    }

    const id = pendingQrPayload?.id || `gw-${Date.now()}`;
    const a = document.createElement("a");
    a.href = pendingRecordedUrl;
    a.download = `goodwills_ritual_${id}.webm`;
    a.click();

    setShowSavePanel(false);
    setPendingRecordedBlob(null);
    setPendingRecordedUrl(null);
    setPendingQrPng(null);
    setPendingQrPayload(null);
  };

  const handleSaveCancel = () => {
    setShowSavePanel(false);
    try {
      if (pendingRecordedUrl) URL.revokeObjectURL(pendingRecordedUrl);
    } catch {}
    setPendingRecordedBlob(null);
    setPendingRecordedUrl(null);
    setPendingQrPng(null);
    setPendingQrPayload(null);
  };

  // ---------------- mint flow ----------------
  const handleGlobalMint = () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    setIntention("");
    setMood("calm");

    setMintFile(null);
    if (mintPreviewUrl) URL.revokeObjectURL(mintPreviewUrl);
    setMintPreviewUrl(null);
    setMintDuration(0);

    setMintQrPayload(null);
    setMintQrText(null);

    mintFileInputRef.current?.click();
  };

  const handleMintFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const res = await scanGoodwillsQrFromFile(file);
    if (!res.ok) {
      alert("Это не файл GOODWILLS: не найден наш QR-код.");
      e.target.value = "";
      return;
    }

    if (mintPreviewUrl) URL.revokeObjectURL(mintPreviewUrl);
    const url = URL.createObjectURL(file);

    setMintFile(file);
    setMintPreviewUrl(url);
    setMintDuration(0);
    setShowMintModal(true);
    setActiveMenu("none");

    setMintQrText(res.payloadText ?? null);
    setMintQrPayload(res.payload ?? null);

    e.target.value = "";
  };

  const closeMintModal = () => {
    setShowMintModal(false);
    setMintFile(null);
    if (mintPreviewUrl) URL.revokeObjectURL(mintPreviewUrl);
    setMintPreviewUrl(null);
    setMintDuration(0);

    setMintQrPayload(null);
    setMintQrText(null);
  };

  const handleMintConfirm = async () => {
    if (!mintFile) {
      alert("Select a WebM file first.");
      return;
    }

    const sourceId = mintQrPayload?.id ?? `gw-${Date.now()}`;
    const createdAt = mintQrPayload?.createdAt ?? new Date().toISOString();

    // compute SHA-256 of video
    let sha = "";
    try {
      sha = await sha256OfBlob(mintFile);
    } catch (e) {
      console.warn("SHA-256 failed:", e);
      sha = "";
    }

    const mintObj: MintJson = {
      signature: "GOODWILLS.MINT",
      v: "0.2",
      id: sourceId,
      createdAt,
      mood,
      intention: intention ? intention : null,
      duration: mintDuration || 0,
      volumes: mintQrPayload?.volumes ?? null,
      qr: mintQrText ?? null,
      source: {
        webmFileName: mintFile.name,
        webmSize: mintFile.size,
        webmDuration: mintDuration || 0,
        sha256: sha,
      },
    };

    try {
      const zip = new JSZip();
      zip.file("mint.json", JSON.stringify(mintObj, null, 2));
      zip.file("video.webm", mintFile);

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `${sourceId}.mint`;
      a.click();

      URL.revokeObjectURL(url);

      closeMintModal();
      alert("✨ Mint pack created: downloaded .mint");
    } catch (e) {
      console.error("Mint pack build failed:", e);
      alert("Mint failed: could not build .mint pack.");
    }
  };

  // ---------------- render ----------------
  return (
    <div className="studio">
      {/* BRAND TOP-LEFT */}
      <div className="brand">
        <div className="brand__name">GOODWILLS</div>
        <div className="brand__tag">RITUAL MIX ENGINE</div>

        <button className="sleep-btn" onClick={toggleSleep}>
          {sleepMode ? "WAKE" : "SLEEP"}
        </button>

        <button className="pill-btn howitworks-btn" onClick={() => setShowHowItWorks(true)}>
          How it works
        </button>
      </div>

     {/* TOP MENU */}
{(!isMobile || showMobileMenu) && (
  <>
    <div className="top-menu">
      <button onClick={() => toggleMenu("presets")}>Samples</button>
      <button onClick={() => toggleMenu("nature")}>Load Nature</button>
      <button onClick={() => toggleMenu("music")}>Load Music</button>
      <button onClick={() => toggleMenu("share")}>Share</button>
      <button onClick={() => toggleMenu("contest")}>Contest</button>
      <button className="top-menu__rituals" onClick={openMyRituals}>
        My rituals
      </button>

      {/* Mobile: close button inside old menu block */}
      {isMobile && (
        <button
          onClick={() => {
            setActiveMenu("none");
            setShowMobileMenu(false);
          }}
        >
          Close
        </button>
      )}
    </div>

    {activeMenu !== "none" && (
      <div
        className="menu-overlay"
        onClick={() => {
          setActiveMenu("none");
          if (isMobile) setShowMobileMenu(false); // клик вне меню закрывает всё
        }}
      />
    )}
  </>
)}

      {/* SUBMENUS */}
      {activeMenu === "presets" && (
        <div className="submenu submenu--presets">
          <button onClick={() => applyPreset("Stormbound")}>Stormbound</button>
          <button onClick={() => applyPreset("SunsetBurn")}>SunsetBurn</button>
          <button onClick={() => applyPreset("VoidStare")}>VoidStare</button>
        </div>
      )}

      {activeMenu === "share" && (
        <div className="submenu submenu--share">
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                alert("Link copied!");
              } catch {
                alert("Could not copy. Please copy from the address bar.");
              }
            }}
          >
            Copy app link
          </button>

          <div className="submenu-note">
            Share your ritual by sending the <b>.mint</b> file to a friend. They can open it in GOODWILLS and it will play instantly.
          </div>
        </div>
      )}

      {activeMenu === "contest" && (
        <div className="submenu submenu--contest">
          <div className="submenu-note">Coming soon — contests are on the way.</div>
        </div>
      )}

      {activeMenu === "nature" && (
        <div className="submenu submenu--nature">
          <button onClick={() => document.getElementById("upload-nature")?.click()}>Upload file nature</button>

          <button onClick={() => window.open("https://pexels.com/search/videos/nature", "_blank")}>
            Open free nature video sites
          </button>
        </div>
      )}

      {activeMenu === "music" && (
        <div className="submenu submenu--music">
          <button onClick={() => document.getElementById("upload-music")?.click()}>Upload file music</button>

          <button onClick={() => window.open("https://pixabay.com/music/", "_blank")}>Open free music libraries</button>
        </div>
      )}

{/* Mobile: single Menu button */}
{isMobile && (
  <div className="mobile-topbar">
    <button
      className="btn-metal"
      onClick={() => {
        setShowMobileMenu(v => {
          const next = !v;
          if (!next) setActiveMenu("none"); // закрываем сабменю вместе с меню
          return next;
        });
      }}
    >
      Menu
    </button>
  </div>
)}

{/* BIG PLAYER */}
<div className="big-player">
  <div className="big-video-stage">
          <video
    ref={bgRef}
    className="big-video"
    src={bgSrc ?? undefined}
    loop
    onTimeUpdate={handleBgTimeUpdate}
  />

          {!bgSrc && (
            <div className="big-center-label">LOAD NATURE</div>
          )}
        </div>

{/* MOBILE FLOATS: мини-плеер + микшер опускаем к панели big-controls */}
{isMobile && (
  <div className="mobile-floats">
    {/* MIXER */}
    <div className="mixer">
      <div className="faders">
        <div className="fader">
          <div className="fader__label">BIG</div>
          <div className="fader__track">
            <div className="fader__scale">
              <span /><span /><span /><span /><span />
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={bgVol}
              onChange={(e) => setBgVol(parseFloat(e.target.value))}
            />
          </div>
        </div>

        <div className="fader">
          <div className="fader__label">SMALL</div>
          <div className="fader__track">
            <div className="fader__scale">
              <span /><span /><span /><span /><span />
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muVol}
              onChange={(e) => setMuVol(parseFloat(e.target.value))}
            />
          </div>
        </div>

        <div className="fader">
          <div className="fader__label">MASTER</div>
          <div className="fader__track">
            <div className="fader__scale">
              <span /><span /><span /><span /><span />
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={masterVol}
              onChange={(e) => setMasterVol(parseFloat(e.target.value))}
            />
          </div>
        </div>
      </div>

      <div className="transport">
        <button className="btn-metal" onClick={handleGlobalPlayPause}>▶/❚❚</button>
        <button className="btn-metal" onClick={handleGlobalStop}>■</button>
        <button
          className={`btn-metal rec-dot-btn ${isRecording ? "rec-on" : ""}`}
          onClick={handleGlobalRec}
        >
          ●
        </button>
        <button className="btn-metal" onClick={handleGlobalMint}>mint</button>
      </div>
    </div>

    {/* MINI PLAYER */}
    <div className="mini-player">
      {muSrc ? (
        <video
          ref={muRef}
          className="mini-video"
          src={muSrc}
          loop
          onTimeUpdate={handleMuTimeUpdate}
        />
      ) : (
        <div className="mini-video mini-video--empty">
          <div className="mini-empty-text">LOAD MUSIC</div>
        </div>
      )}

      <div className="mini-bottom">
        <div className="mini-divider" />

        <div className="mini-controls-panel">
          <button className="btn-metal btn-metal--small" onClick={handleMuPlayPause} disabled={!muSrc}>
            ▶/❚❚
          </button>
          <button className="btn-metal btn-metal--small" onClick={handleMuStop} disabled={!muSrc}>
            ■
          </button>

          <button
            className={`btn-metal btn-metal--small btn-glue ${isGlued ? "glue-on" : ""} ${!muSrc ? "btn-disabled" : ""}`}
            onClick={() => muSrc && toggleGlue()}
            disabled={!muSrc}
            title="Glue timelines"
          >
            <span className="btn-glue__label">glue</span>
            <span className="btn-glue__mark" />
          </button>
        </div>

        <input
          className="timeline mini-timeline"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={muProgress}
          onChange={(e) => muSrc && handleMuTimelineChange(parseFloat(e.target.value))}
          disabled={!muSrc}
        />

        <div className="timeline-ruler timeline-ruler--mini">
          <div className="mm-grid"></div>
          <div className="cm-labels">
            {Array.from({ length: 30 }).map((_, i) => (
              <span key={i} style={{ left: `${(i + 1) * 50}px` }}>
                {i + 1}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  </div>
)}

  <div className="big-bottom">
    <div className="big-divider" />

    <div className="big-controls-panel">
      <button
  className={`btn-metal ${!bgSrc ? "btn-disabled" : ""}`}
  onClick={() => bgSrc && handleBgPlayPause()}
  disabled={!bgSrc}
>
  ▶/❚❚
</button>

<button
  className={`btn-metal ${!bgSrc ? "btn-disabled" : ""}`}
  onClick={() => bgSrc && handleBgStop()}
  disabled={!bgSrc}
>
  ■
</button>

      <div className={`rec-timer ${isRecording ? "rec-on" : ""}`}>
        {String(recTime).padStart(2, "0")} / {RECORD_LIMIT_SEC}
      </div>

      <button
        className={`btn-metal btn-glue ${isGlued ? "glue-on" : ""} ${!muSrc ? "btn-disabled" : ""}`}
        onClick={() => muSrc && toggleGlue()}
        disabled={!muSrc}
        title="Glue timelines"
      >
        <span className="btn-glue__label">glue</span>
        <span className="btn-glue__mark" />
      </button>
    </div>

    <input
      className="timeline big-timeline"
      type="range"
      min={0}
      max={1}
      step={0.001}
      value={bgProgress}
      onChange={(e) => handleBgTimelineChange(parseFloat(e.target.value))}
    />

          {/* RULER */}
          <div className="timeline-ruler timeline-ruler--big">
            <div className="mm-grid"></div>
            <div className="cm-labels">
              {Array.from({ length: 30 }).map((_, i) => (
                <span key={i} style={{ left: `${(i + 1) * 50}px` }}>
                  {i + 1}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

     {!isMobile && (
       <>
      {/* MINI PLAYER */}
      <div className="mini-player">
        {muSrc ? (
          <video ref={muRef} className="mini-video" src={muSrc} loop onTimeUpdate={handleMuTimeUpdate} />
        ) : (
          <div className="mini-video mini-video--empty">
            <div className="mini-empty-text">LOAD MUSIC</div>
          </div>
        )}

        <div className="mini-bottom">
          <div className="mini-divider" />

          <div className="mini-controls-panel">
            <button className="btn-metal btn-metal--small" onClick={handleMuPlayPause} disabled={!muSrc}>
              ▶/❚❚
            </button>
            <button className="btn-metal btn-metal--small" onClick={handleMuStop} disabled={!muSrc}>
              ■
            </button>
          
            <button
              className={`btn-metal btn-metal--small btn-glue ${isGlued ? "glue-on" : ""} ${!muSrc ? "btn-disabled" : ""}`}
              onClick={() => muSrc && toggleGlue()}
              disabled={!muSrc}
              title="Glue timelines"
            >
              <span className="btn-glue__label">glue</span>
              <span className="btn-glue__mark" />
            </button>
          </div>

          <input
            className="timeline mini-timeline"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={muProgress}
            onChange={e => muSrc && handleMuTimelineChange(parseFloat(e.target.value))}
            disabled={!muSrc}
          />

          {/* RULER */}
          <div className="timeline-ruler timeline-ruler--mini">
            <div className="mm-grid"></div>
            <div className="cm-labels">
              {Array.from({ length: 30 }).map((_, i) => (
                <span key={i} style={{ left: `${(i + 1) * 50}px` }}>
                  {i + 1}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* MIXER + GLOBAL TRANSPORT */}
      <div className="mixer">
        <div className="faders">
          <div className="fader">
            <div className="fader__label">BIG</div>
            <div className="fader__track">
              <div className="fader__scale">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <input type="range" min={0} max={1} step={0.01} value={bgVol} onChange={e => setBgVol(parseFloat(e.target.value))} />
            </div>
          </div>

          <div className="fader">
            <div className="fader__label">SMALL</div>
            <div className="fader__track">
              <div className="fader__scale">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <input type="range" min={0} max={1} step={0.01} value={muVol} onChange={e => setMuVol(parseFloat(e.target.value))} />
            </div>
          </div>

          <div className="fader">
            <div className="fader__label">MASTER</div>
            <div className="fader__track">
              <div className="fader__scale">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <input type="range" min={0} max={1} step={0.01} value={masterVol} onChange={e => setMasterVol(parseFloat(e.target.value))} />
            </div>
          </div>
        </div>

        <div className="transport">
          <button className="btn-metal" onClick={handleGlobalPlayPause}>
            ▶/❚❚
          </button>
          <button className="btn-metal" onClick={handleGlobalStop}>
            ■
          </button>
          <button
            className={`btn-metal rec-dot-btn ${isRecording ? "rec-on" : ""} `}
            onClick={handleGlobalRec}
          >
            ●
          </button>
          <button className="btn-metal" onClick={handleGlobalMint}>
            mint
          </button>
        </div>
      </div>
          </>
        )}

      {/* HIDDEN INPUTS */}
      <input id="upload-nature" type="file" accept="video/*" style={{ display: "none" }} onChange={handleUploadNature} />
      <input id="upload-music" type="file" accept="audio/*,video/*" style={{ display: "none" }} onChange={handleUploadMusic} />
      <input ref={mintFileInputRef} id="mint-file" type="file" accept="video/webm,video/*" style={{ display: "none" }} onChange={handleMintFilePicked} />
      <input
        ref={ritualsMintInputRef}
        id="rituals-mint" 
        type="file"
        accept=".mint,application/octet-stream"
        multiple
        style={{ display: "none" }}
        onChange={handleRitualMintFilesPicked}
      />

      {/* SAVE PANEL (after recording) */}
      {showSavePanel && (
        <div className="mint-overlay" onClick={handleSaveCancel}>
          <div className="mint-window" onClick={e => e.stopPropagation()}>
            <h3>SAVE — recorded ritual</h3>

            <div className="mint-body">
              {pendingRecordedUrl && (
                <div className="mint-preview">
                  <video src={pendingRecordedUrl} controls />
                </div>
              )}

              <div style={{ marginTop: 10, lineHeight: 1.5 }}>
                <div>
                  <b>ID:</b> {pendingQrPayload?.id ?? "—"}
                </div>

                <div>
                  <b>Date:</b> {pendingQrPayload?.createdAt ? new Date(pendingQrPayload.createdAt).toLocaleString() : "—"}
                </div>

                <div>
                  <b>Faders:</b> {pendingQrPayload?.volumes?.big?.toFixed?.(2) ?? "—"} / BIG {pendingQrPayload?.volumes?.small?.toFixed?.(2) ?? "—"} / SMALL {pendingQrPayload?.volumes?.master?.toFixed?.(2) ?? "—"} / MASTER
                </div>
              </div>

              {pendingQrPng && (
                <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12 }}>
                  <img
                    src={pendingQrPng}
                    alt="QR"
                    style={{ width: 110, height: 110, borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)" }}
                  />
                  <div style={{ opacity: 0.8, fontSize: 12 }}>QR is already burned into the video (top-left, under watermark).</div>
                </div>
              )}
            </div>

            <div className="mint-actions">
              <button className="btn-metal" onClick={handleSaveCancel}>
                Cancel
              </button>
              <button className="btn-metal" onClick={handleSaveConfirm}>
                Download
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MINT MODAL */}
      {showMintModal && (
        <div className="mint-overlay" onClick={closeMintModal}>
          <div className="mint-window" onClick={e => e.stopPropagation()}>
            <h3>MINT — create .mint pack</h3>

            {mintFile && (
              <div className="mint-fileline">
                File: {mintFile.name} ({Math.round(mintFile.size / 1024)} KB)
              </div>
            )}

            {mintPreviewUrl && (
              <div className="mint-preview">
                <video
                  src={mintPreviewUrl}
                  controls
                  onLoadedMetadata={e => {
                    const d = (e.currentTarget as HTMLVideoElement).duration;
                    if (Number.isFinite(d)) setMintDuration(Math.round(d));
                  }}
                />
              </div>
            )}

            <label style={{ display: "block", marginTop: 12 }}>
              Mood:
              <select style={{ marginLeft: 10 }} value={mood} onChange={e => setMood(e.target.value)}>
                <option value="calm">calm</option>
                <option value="power">power</option>
                <option value="nostalgia">nostalgia</option>
                <option value="focus">focus</option>
                <option value="hope">hope</option>
              </select>
            </label>

            <label style={{ display: "block", marginTop: 10 }}>
              Intention (optional):
              <input
                style={{ width: "100%", marginTop: 6 }}
                type="text"
                value={intention}
                onChange={e => setIntention(e.target.value)}
                placeholder="Why did you make this ritual?"
              />
            </label>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn-metal" onClick={closeMintModal}>
                Cancel
              </button>
              <button className="btn-metal" onClick={() => void handleMintConfirm()}>
                Mint
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MY RITUALS */}
      {showMyRituals && (
        <div className="mint-overlay" onClick={closeMyRituals}>
          <div className="mint-dialog" onClick={e => e.stopPropagation()}>
            {!selectedPack && (
              <>
                <h3>My rituals (.mint)</h3>
                {packs.length === 0 ? <p>No packs loaded. Select .mint files.</p> : null}

                <ul className="mint-list">
                  {packs.map(p => (
                    <li key={p.fileName} className="mint-item">
                      <button onClick={() => void openPack(p)}>
                        {p.data.id} — {new Date(p.data.createdAt).toLocaleString()} — {p.fileName}
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="mint-actions">
                  <button className="btn-metal" onClick={() => ritualsMintInputRef.current?.click()}>
                    Load .mint
                  </button>
                  <button className="btn-metal" onClick={closeMyRituals}>
                    Close
                  </button>
                </div>
              </>
            )}

            {selectedPack && (
              <>
                <h3>{selectedPack.data.id}</h3>

                <p>
                  <b>Date:</b> {new Date(selectedPack.data.createdAt).toLocaleString()}
                </p>
                <p>
                  <b>Mood:</b> {selectedPack.data.mood || "—"}
                </p>
                <p>
                <p className="ritual-intention">
                  <b>Intention:</b> {selectedPack.data.intention || "—"}
               </p>
                  <b>Duration:</b> {selectedPack.data.duration}s
                </p>
                <p>
                  <b>SHA-256:</b> {selectedPack.data.source.sha256 ? selectedPack.data.source.sha256 : "—"}
                </p>

                {selectedPackVideoUrl ? (
                  <div className="mint-preview">
                    <video src={selectedPackVideoUrl} controls />
                  </div>
                ) : (
                  <p>Video not found in pack.</p>
                )}

                <div className="mint-actions">
                  <button
                    className="btn-metal"
                    onClick={() => {
                      setSelectedPack(null);
                      if (selectedPackVideoUrl) URL.revokeObjectURL(selectedPackVideoUrl);
                      setSelectedPackVideoUrl(null);
                    }}
                  >
                    Back
                  </button>
                  <button className="btn-metal" onClick={closeMyRituals}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

      )}

      {/* HOW IT WORKS */}
      {showHowItWorks && (
        <div className="mint-overlay" onClick={() => setShowHowItWorks(false)}>
          <div className="mint-dialog how-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>How it works</h3>

            <div className="how-body">
              <p>
                <b>GOODWILLS</b> is a ritual instrument. There is no automation — you are always in control.
              </p>
              
              <h4>1) Choose nature</h4>
              <p>Select a background that matches your current state.</p>

              <h4>2) Load your music</h4>
              <p>Add a track that matters to you.</p>

              <h4>3) Enter the ritual</h4>
              <p>Adjust the volume faders (BIG / SMALL / MASTER) until you feel the right balance.</p>

              <h4>4) Align the moment</h4>
              <p>Use the timelines to search for resonance. Use <b>Glue</b> to keep the offset while moving both.</p>

              <h4>5) Record & mint</h4>
              <p>Press <b>Record</b> when it feels right (max {RECORD_LIMIT_SEC}s). Then mint into a <b>.mint</b> file to store or share.</p>
            
              <p>
                👉{" "} 
                <a
      href="https://youtu.be/fgqpXFjC5H8?si=1ROiFCVOBA9AktDs"
      target="_blank"
      rel="noopener noreferrer"
      className="how-link"
    >
      Watch a short demonstration video
    </a>
    </p>
 </div>

            <div className="mint-actions">
              <button className="btn-metal" onClick={() => setShowHowItWorks(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SLEEP OVERLAY */}
      {sleepMode && <div className="night" onClick={toggleSleep} />}
    </div>
  );
};

export default Studio;
