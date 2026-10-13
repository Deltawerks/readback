# ReadBack audio helper (Windows). The panel server's ducking driver starts it,
# through scripts/audio-helper-relay.js, while ducking is switched on and for a
# short cleanup run with ducking off when apps a crash left lowered remain to be
# put back. It talks to the driver in JSON lines, one per line:
#
#   stdout  {"t":"ready","v":1} once it is listening, then
#           {"t":"state","seq":N,"mic":[...],"out":[...]} on any change and at
#           least every 2 s, plus the odd {"t":"log","msg":"..."}.
#   stdin   {"c":"set","seq":N,"key":K,"vol":V,"orig":O}   set one session
#           {"c":"arm","seq":N,"pid":P,"vol":V|null}       hold a process's sessions
#           {"c":"forget","seq":N,"key":K}                 stop remembering one
#           {"c":"quit"}                                   put back, then exit
#
# EOF on stdin means the panel server is gone and is treated exactly like quit:
# every level this helper lowered goes back (unless the user has moved it
# since), armed processes go back to full, and it exits. It knows nothing about
# ReadBack beyond this protocol. Every decision (what to lower, how far, when to
# put it back, what to restore after a crash) is made by the referee in
# src/ducking.js, which the panel's driver runs; this helper only applies the
# levels it is sent and reports the audio sessions Windows lists.
#
# Windows PowerShell 5.1 compiles the C# below with the .NET Framework compiler,
# so it sticks to C# 5: no string interpolation, no ?., no nameof, no out var.
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ReadbackAudio
{
    // ---- Core Audio COM interfaces. Method order is the vtable order. ----

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("641DD20B-4D41-49CC-ABA3-174B9477BB08"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionNotification
    {
        [PreserveSig] int OnSessionCreated(IntPtr newSession);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr sessionControl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, [MarshalAs(UnmanagedType.IUnknown)] out object audioVolume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
        [PreserveSig] int RegisterSessionNotification(IAudioSessionNotification notification);
        [PreserveSig] int UnregisterSessionNotification(IAudioSessionNotification notification);
        [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
        [PreserveSig] int UnregisterDuckNotification(IntPtr duckNotification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
        [PreserveSig] int GetGroupingParam(out Guid param);
        [PreserveSig] int SetGroupingParam(ref Guid param, ref Guid ctx);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    public class Endpoint
    {
        public string Id;
        public bool IsMic;
        public IAudioSessionManager2 Manager;
        public SessionSink Sink;
    }

    // Windows calls this on one of its own threads when a device gets a new
    // session. An arm is applied right here, before the stream starts, so a
    // ReadBack sentence that begins mid-dictation is quiet from its first sample.
    [ComVisible(true)]
    public class SessionSink : IAudioSessionNotification
    {
        public Endpoint Ep;
        public Helper Owner;

        public int OnSessionCreated(IntPtr newSession)
        {
            try
            {
                if (newSession != IntPtr.Zero) Owner.Created(Ep, Marshal.GetObjectForIUnknown(newSession));
            }
            catch { }
            return 0;
        }
    }

    public class Session
    {
        public string Key;
        public uint Pid;
        public string Name;
        public bool IsMic;
        public bool IsSystem;
        public IAudioSessionControl2 Control;
        public ISimpleAudioVolume Volume;
        public int State = -1;
        public float Level = -1f;
    }

    public class Remembered
    {
        public float Orig;
        public float LastSet;
    }

    public class Helper
    {
        const int RENDER = 0, CAPTURE = 1, ACTIVE_DEVICES = 1, CLSCTX_ALL = 0x17;
        const int ACTIVE = 1, EXPIRED = 2;
        static readonly Guid IidManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        static readonly Guid ClsidEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        // Tags our own changes in Windows' volume-change notifications.
        Guid context = new Guid("5E0D1C3A-8B7F-4C26-9A41-7D2E6F1B0C55");

        readonly ConcurrentQueue<Action> commands = new ConcurrentQueue<Action>();
        readonly ConcurrentQueue<KeyValuePair<Endpoint, object>> created = new ConcurrentQueue<KeyValuePair<Endpoint, object>>();
        readonly ConcurrentDictionary<uint, float> arms = new ConcurrentDictionary<uint, float>();
        readonly Dictionary<string, Endpoint> endpoints = new Dictionary<string, Endpoint>();
        readonly Dictionary<string, Session> sessions = new Dictionary<string, Session>();
        readonly HashSet<string> expired = new HashSet<string>();
        readonly Dictionary<string, Remembered> remembered = new Dictionary<string, Remembered>();
        readonly Dictionary<uint, string> names = new Dictionary<uint, string>();
        readonly object writeLock = new object();
        readonly uint self = (uint)Process.GetCurrentProcess().Id;
        IMMDeviceEnumerator enumerator;
        Thread worker;
        volatile bool stopping;
        long seq;
        bool loweredPlayers;
        string lastLine = "";
        DateTime lastEmit = DateTime.MinValue;

        public void Start()
        {
            worker = new Thread(Run);
            // Core Audio only delivers new-session notifications to an MTA thread.
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
        }

        public void Set(long s, string key, double vol, double orig)
        {
            commands.Enqueue(() => ApplySet(s, key, (float)vol, (float)orig));
        }

        public void Arm(long s, int pid, double vol)
        {
            commands.Enqueue(() => ApplyArm(s, (uint)pid, (float)vol));
        }

        public void Forget(long s, string key)
        {
            commands.Enqueue(() => { Bump(s); remembered.Remove(key); });
        }

        public void Log(string message)
        {
            Emit("{\"t\":\"log\",\"msg\":" + Json(message) + "}");
        }

        public void Stop()
        {
            stopping = true;
            if (worker != null) worker.Join(10000);
        }

        public void Created(Endpoint ep, object so)
        {
            try
            {
                IAudioSessionControl2 control = so as IAudioSessionControl2;
                uint pid;
                float vol;
                if (!ep.IsMic && control != null && control.GetProcessId(out pid) >= 0 && arms.TryGetValue(pid, out vol))
                {
                    ISimpleAudioVolume v = so as ISimpleAudioVolume;
                    if (v != null) v.SetMasterVolume(vol, ref context);
                }
            }
            catch { }
            created.Enqueue(new KeyValuePair<Endpoint, object>(ep, so));
        }

        void Bump(long s)
        {
            if (s > seq) seq = s;
        }

        static float Clamp(float v)
        {
            return v < 0f ? 0f : (v > 1f ? 1f : v);
        }

        void ApplySet(long s, string key, float vol, float orig)
        {
            Bump(s);
            Session x;
            if (!sessions.TryGetValue(key, out x) || x.Volume == null) return;
            vol = Clamp(vol);
            x.Volume.SetMasterVolume(vol, ref context);
            x.Level = vol;
            if (orig < 0f) return;
            Remembered r;
            if (!remembered.TryGetValue(key, out r))
            {
                r = new Remembered();
                remembered[key] = r;
            }
            r.Orig = Clamp(orig);
            r.LastSet = vol;
        }

        void ApplyArm(long s, uint pid, float vol)
        {
            Bump(s);
            float old;
            if (vol < 0f)
            {
                arms.TryRemove(pid, out old);
                return;
            }
            vol = Clamp(vol);
            arms[pid] = vol;
            // Only a lowered powershell.exe (one of ReadBack's players) can leave a
            // low level for the next player to inherit; any other app is not ours
            // to reset.
            if (vol < 0.999f && IsPowerShell(pid)) loweredPlayers = true;
            foreach (Session x in sessions.Values)
            {
                if (x.IsMic || x.Pid != pid || x.Volume == null) continue;
                x.Volume.SetMasterVolume(vol, ref context);
                x.Level = vol;
            }
        }

        void Run()
        {
            bool clean = false;
            try
            {
                enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(ClsidEnumerator));
                RefreshEndpoints();
                Discover();
                Emit("{\"t\":\"ready\",\"v\":1}");
                DateTime devicesAt = DateTime.UtcNow;
                DateTime discoverAt = DateTime.UtcNow;
                DateTime outAt = DateTime.MinValue;
                while (!stopping)
                {
                    bool applied = DrainCommands();
                    DrainCreated();
                    DateTime now = DateTime.UtcNow;
                    if ((now - devicesAt).TotalMilliseconds >= 5000) { RefreshEndpoints(); devicesAt = now; }
                    if ((now - discoverAt).TotalMilliseconds >= 1000) { Discover(); discoverAt = now; }
                    bool readOut = applied || (now - outAt).TotalMilliseconds >= 100;
                    if (readOut) outAt = now;
                    Poll(readOut);
                    Report(now);
                    Thread.Sleep(50);
                }
                clean = true;
            }
            catch (Exception e)
            {
                Log("helper failed: " + e.Message);
            }
            finally
            {
                try
                {
                    DrainCommands();
                    RestoreAndRelease();
                }
                catch { }
            }
            // Died on its own: end the process, so the panel restarts it rather
            // than keeping a helper that reads commands and does nothing.
            if (!clean) Environment.Exit(3);
        }

        bool DrainCommands()
        {
            bool any = false;
            Action a;
            while (commands.TryDequeue(out a))
            {
                any = true;
                try { a(); }
                catch (Exception e) { Log("command failed: " + e.Message); }
            }
            return any;
        }

        void RefreshEndpoints()
        {
            HashSet<string> seen = new HashSet<string>();
            foreach (int flow in new int[] { RENDER, CAPTURE })
            {
                IMMDeviceCollection col;
                if (enumerator.EnumAudioEndpoints(flow, ACTIVE_DEVICES, out col) != 0 || col == null) continue;
                int count;
                col.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IMMDevice dev;
                    if (col.Item(i, out dev) != 0 || dev == null) continue;
                    string id;
                    if (dev.GetId(out id) != 0 || id == null) continue;
                    seen.Add(id);
                    if (endpoints.ContainsKey(id)) continue;
                    Guid iid = IidManager2;
                    object o;
                    if (dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o) != 0 || o == null) continue;
                    Endpoint ep = new Endpoint();
                    ep.Id = id;
                    ep.IsMic = flow == CAPTURE;
                    ep.Manager = (IAudioSessionManager2)o;
                    try
                    {
                        // Take an enumerator first, then listen for new sessions so
                        // later enumerations stay current.
                        IAudioSessionEnumerator warm;
                        ep.Manager.GetSessionEnumerator(out warm);
                        SessionSink sink = new SessionSink();
                        sink.Ep = ep;
                        sink.Owner = this;
                        if (ep.Manager.RegisterSessionNotification(sink) == 0) ep.Sink = sink;
                    }
                    catch (Exception e)
                    {
                        Log("no new-session events on a device: " + e.Message);
                    }
                    endpoints[id] = ep;
                }
            }
            List<string> gone = new List<string>();
            foreach (string id in endpoints.Keys) if (!seen.Contains(id)) gone.Add(id);
            foreach (string id in gone) endpoints.Remove(id);
        }

        void Discover()
        {
            foreach (Endpoint ep in endpoints.Values)
            {
                IAudioSessionEnumerator list;
                if (ep.Manager.GetSessionEnumerator(out list) != 0 || list == null) continue;
                int count;
                list.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    object so;
                    if (list.GetSession(i, out so) == 0 && so != null) Track(ep, so);
                }
            }
        }

        void DrainCreated()
        {
            KeyValuePair<Endpoint, object> item;
            while (created.TryDequeue(out item)) Track(item.Key, item.Value);
        }

        void Track(Endpoint ep, object so)
        {
            IAudioSessionControl2 control = so as IAudioSessionControl2;
            if (control == null) return;
            string key;
            if (control.GetSessionInstanceIdentifier(out key) != 0 || key == null) return;
            if (sessions.ContainsKey(key) || expired.Contains(key)) return;
            uint pid;
            control.GetProcessId(out pid);
            Session x = new Session();
            x.Key = key;
            x.Pid = pid;
            x.Name = NameOf(pid);
            x.IsMic = ep.IsMic;
            x.IsSystem = control.IsSystemSoundsSession() == 0;
            x.Control = control;
            x.Volume = ep.IsMic ? null : so as ISimpleAudioVolume;
            int st;
            x.State = control.GetState(out st) == 0 ? st : -1;
            float vol;
            // A new session of an armed process that the notification missed.
            if (x.Volume != null && arms.TryGetValue(pid, out vol)) x.Volume.SetMasterVolume(vol, ref context);
            float level;
            if (x.Volume != null && x.Volume.GetMasterVolume(out level) == 0) x.Level = level;
            sessions[key] = x;
        }

        bool IsPowerShell(uint pid)
        {
            string name = NameOf(pid).ToLowerInvariant();
            return name == "powershell" || name == "pwsh";
        }

        string NameOf(uint pid)
        {
            if (pid == 0) return "";
            string name;
            if (names.TryGetValue(pid, out name)) return name;
            try
            {
                using (Process p = Process.GetProcessById((int)pid)) name = p.ProcessName;
            }
            catch
            {
                name = "";
            }
            names[pid] = name;
            return name;
        }

        void Poll(bool readOut)
        {
            List<string> drop = null;
            foreach (Session x in sessions.Values)
            {
                if (!x.IsMic && !readOut) continue;
                int st;
                if (x.Control.GetState(out st) != 0) st = EXPIRED;
                x.State = st;
                if (st == EXPIRED)
                {
                    if (drop == null) drop = new List<string>();
                    drop.Add(x.Key);
                    continue;
                }
                float v;
                if (x.Volume != null && x.Volume.GetMasterVolume(out v) == 0) x.Level = v;
            }
            if (drop == null) return;
            foreach (string key in drop)
            {
                Session x = sessions[key];
                sessions.Remove(key);
                expired.Add(key);
                remembered.Remove(key);
                names.Remove(x.Pid); // the pid may be reused by a new process
            }
        }

        void Report(DateTime now)
        {
            StringBuilder b = new StringBuilder();
            b.Append("{\"t\":\"state\",\"seq\":").Append(seq).Append(",\"mic\":[");
            bool first = true;
            foreach (Session x in sessions.Values)
            {
                if (!x.IsMic || x.Pid == 0 || x.Pid == self) continue;
                if (!first) b.Append(',');
                first = false;
                b.Append("{\"pid\":").Append(x.Pid)
                 .Append(",\"name\":").Append(Json(x.Name))
                 .Append(",\"active\":").Append(x.State == ACTIVE ? "true" : "false").Append('}');
            }
            b.Append("],\"out\":[");
            first = true;
            foreach (Session x in sessions.Values)
            {
                if (x.IsMic || x.Pid == self) continue;
                if (!first) b.Append(',');
                first = false;
                b.Append("{\"key\":").Append(Json(x.Key))
                 .Append(",\"pid\":").Append(x.Pid)
                 .Append(",\"name\":").Append(Json(x.Name))
                 .Append(",\"vol\":").Append(x.Level.ToString("0.###", CultureInfo.InvariantCulture))
                 .Append(",\"playing\":").Append(x.State == ACTIVE ? "true" : "false")
                 .Append(",\"system\":").Append(x.IsSystem ? "true" : "false").Append('}');
            }
            b.Append("]}");
            string line = b.ToString();
            if (line == lastLine && (now - lastEmit).TotalMilliseconds < 2000) return;
            lastLine = line;
            lastEmit = now;
            Emit(line);
        }

        void RestoreAndRelease()
        {
            foreach (KeyValuePair<string, Remembered> kv in remembered)
            {
                Session x;
                float current;
                if (!sessions.TryGetValue(kv.Key, out x) || x.Volume == null) continue;
                if (x.Volume.GetMasterVolume(out current) != 0) continue;
                // Moved since we set it: that is the user's level now; leave it.
                if (Math.Abs(current - kv.Value.LastSet) <= 0.01f) x.Volume.SetMasterVolume(kv.Value.Orig, ref context);
            }
            remembered.Clear();
            foreach (KeyValuePair<uint, float> arm in arms)
            {
                if (arm.Value >= 0.999f) continue;
                foreach (Session x in sessions.Values)
                {
                    if (!x.IsMic && x.Pid == arm.Key && x.Volume != null) x.Volume.SetMasterVolume(1f, ref context);
                }
            }
            if (loweredPlayers) ResetOwnLevel();
            foreach (Endpoint ep in endpoints.Values)
            {
                if (ep.Sink == null) continue;
                try { ep.Manager.UnregisterSessionNotification(ep.Sink); }
                catch { }
            }
        }

        // Windows can carry one process's per-app level over to the next process
        // of the same program. ReadBack's players are powershell.exe, and so is
        // this helper, so setting our own default session to full resets what
        // the next player inherits once nothing is left to arm it.
        void ResetOwnLevel()
        {
            Log("reset the level Windows keeps for powershell.exe to full");
            foreach (Endpoint ep in endpoints.Values)
            {
                if (ep.IsMic) continue;
                try
                {
                    object o;
                    if (ep.Manager.GetSimpleAudioVolume(IntPtr.Zero, 0, out o) != 0 || o == null) continue;
                    ISimpleAudioVolume v = o as ISimpleAudioVolume;
                    if (v != null) v.SetMasterVolume(1f, ref context);
                }
                catch { }
            }
        }

        void Emit(string line)
        {
            lock (writeLock)
            {
                Console.Out.Write(line);
                Console.Out.Write("\n");
                Console.Out.Flush();
            }
        }

        // ASCII-only JSON strings: Windows PowerShell's pipes use the console code
        // page, and \uXXXX survives any of them.
        static string Json(string s)
        {
            StringBuilder b = new StringBuilder("\"");
            foreach (char c in s ?? "")
            {
                if (c == '"' || c == '\\') b.Append('\\').Append(c);
                else if (c < ' ' || c > '~') b.Append("\\u").Append(((int)c).ToString("x4"));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

$helper = New-Object ReadbackAudio.Helper
$helper.Start()
try {
  $quit = $false
  while (-not $quit) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break } # EOF: the panel server is gone
    if ($line.Trim() -eq '') { continue }
    try {
      $cmd = $line | ConvertFrom-Json
    } catch {
      $helper.Log('ignored a line that was not JSON')
      continue
    }
    $seq = [int64]0
    if ($null -ne $cmd.seq) { $seq = [int64]$cmd.seq }
    switch ([string]$cmd.c) {
      'set' {
        $orig = -1.0
        if ($null -ne $cmd.orig) { $orig = [double]$cmd.orig }
        $helper.Set($seq, [string]$cmd.key, [double]$cmd.vol, $orig)
      }
      'arm' {
        $vol = -1.0
        if ($null -ne $cmd.vol) { $vol = [double]$cmd.vol }
        $helper.Arm($seq, [int]$cmd.pid, $vol)
      }
      'forget' { $helper.Forget($seq, [string]$cmd.key) }
      'quit' { $quit = $true }
      default { $helper.Log('ignored an unknown command') }
    }
  }
}
finally {
  $helper.Stop()
}
