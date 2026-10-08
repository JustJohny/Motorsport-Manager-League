// Patches MM's Assembly-CSharp.dll so it calls LeaguePatch.Hooks: SessionManager.StartSession ->
// OnSessionStart, AtlasManager.UpdateAtlasesWithMods -> OnAtlasesUpdated, LocalisationReader.LoadFromFile
// -> OnTextLoaded (each at the end of the method, with the argument the hook takes).
//
//   league-patch <MM_Data/Managed> <LeaguePatch.dll>   patch (from the .orig backup if there is one)
//   league-patch <MM_Data/Managed> --restore           put the original back
//   league-patch <MM_Data/Managed> --status            say whether the game is patched
//
// The original is kept as Assembly-CSharp.dll.orig and every patch starts from it, so patching twice
// never stacks calls. Unity Mod Manager's "Assembly" install method also edits Assembly-CSharp.dll;
// patching or restoring from the backup would silently drop it, so both refuse while it's there
// (install UMM with its DoorstopProxy method instead, which leaves the DLL alone).
using Mono.Cecil;
using Mono.Cecil.Cil;

const string Target = "Assembly-CSharp.dll";
const string Backup = "Assembly-CSharp.dll.orig";
const string HookType = "LeaguePatch.Hooks";
const string HookMethod = "OnSessionStart";

if (args.Length < 2) return Fail("usage: league-patch <MM_Data/Managed> <LeaguePatch.dll> | --restore | --status");
string managed = args[0];
string dll = Path.Combine(managed, Target), orig = Path.Combine(managed, Backup);
if (!File.Exists(dll)) return Fail($"no {Target} in {managed}");

string gameDir = Path.GetFullPath(Path.Combine(managed, "..", ".."));
bool umm = HasModManager(dll);
if (args[1] == "--status")
{
    Console.WriteLine(IsPatched(dll) ? "patched" : "not patched");
    if (umm) Console.WriteLine("Unity Mod Manager: injected into Assembly-CSharp.dll (Assembly method); reinstall it with DoorstopProxy before patching");
    else if (File.Exists(Path.Combine(gameDir, "winhttp.dll")) || File.Exists(Path.Combine(gameDir, "doorstop_config.ini")))
        Console.WriteLine("Unity Mod Manager: Doorstop proxy (winhttp.dll); under Wine run MM with WINEDLLOVERRIDES=winhttp=n,b");
    return 0;
}
if (umm)
    return Fail("Unity Mod Manager is injected into Assembly-CSharp.dll; patching or restoring from the backup would remove it. "
        + "Uninstall it in UMM, reinstall it with the DoorstopProxy method, then run this again.");
if (args[1] == "--restore")
{
    if (!File.Exists(orig)) return Fail($"no {Backup}; the game was never patched by this tool");
    File.Copy(orig, dll, overwrite: true);
    File.Delete(orig);
    string hook = Path.Combine(managed, "LeaguePatch.dll");
    if (File.Exists(hook)) File.Delete(hook);
    Console.WriteLine("restored the original Assembly-CSharp.dll");
    return 0;
}

string hookDll = args[1];
if (!File.Exists(hookDll)) return Fail($"no {hookDll}");
if (!File.Exists(orig))
{
    if (IsPatched(dll)) return Fail($"{Target} is patched but {Backup} is missing; reinstall the original first");
    File.Copy(dll, orig);
    Console.WriteLine($"backed up the original as {Backup}");
}

var resolver = new DefaultAssemblyResolver();
resolver.AddSearchDirectory(managed);
var hookAsm = AssemblyDefinition.ReadAssembly(hookDll);
MethodDefinition Hook(string name) => hookAsm.MainModule.GetType(HookType)?.Methods.FirstOrDefault(m => m.Name == name)
    ?? throw new Exception($"{HookType}.{name} not found in {hookDll}");

// (game type, method, parameter count, argument passed to the hook: 0 = this or first parameter, hook)
var targets = new (string Type, string Method, int Params, int Arg, string Hook)[]
{
    ("SessionManager", "StartSession", 0, 0, HookMethod),
    ("AtlasManager", "UpdateAtlasesWithMods", 0, 0, "OnAtlasesUpdated"),
    ("LocalisationReader", "LoadFromFile", 3, 1, "OnTextLoaded"),
};

using (var asm = AssemblyDefinition.ReadAssembly(orig, new ReaderParameters { AssemblyResolver = resolver }))
{
    var module = asm.MainModule;
    foreach (var t in targets)
    {
        var method = module.GetType(t.Type)?.Methods.FirstOrDefault(m => m.Name == t.Method && m.Parameters.Count == t.Params)
            ?? throw new Exception($"{t.Type}.{t.Method} not found; is this MM 1.53?");
        var call = module.ImportReference(Hook(t.Hook));
        var il = method.Body.GetILProcessor();
        // Before every return, so the hook runs once the method has done its work.
        foreach (var ret in method.Body.Instructions.Where(i => i.OpCode == OpCodes.Ret).ToList())
        {
            var load = il.Create(t.Arg == 0 ? OpCodes.Ldarg_0 : OpCodes.Ldarg_1);
            il.InsertBefore(ret, load);
            il.InsertBefore(ret, il.Create(OpCodes.Call, call));
            // Branches that jumped to the return now land on the hook call first.
            foreach (var i in method.Body.Instructions.Where(i => i.Operand == ret && i != load)) i.Operand = load;
            // Exception handlers that ended at the return still end before the hook.
            foreach (var h in method.Body.ExceptionHandlers)
            {
                if (h.HandlerEnd == ret) h.HandlerEnd = load;
                if (h.TryEnd == ret) h.TryEnd = load;
            }
        }
        Console.WriteLine($"  {t.Type}.{t.Method} -> {HookType}.{t.Hook}");
    }
    asm.Write(dll);
}
File.Copy(hookDll, Path.Combine(managed, "LeaguePatch.dll"), overwrite: true);
Console.WriteLine($"patched {Target}");
return 0;

static bool IsPatched(string path)
{
    using var asm = AssemblyDefinition.ReadAssembly(path);
    var start = asm.MainModule.GetType("SessionManager")?.Methods.FirstOrDefault(m => m.Name == "StartSession" && !m.HasParameters);
    return start?.Body.Instructions.Any(i => i.Operand is MethodReference m && m.DeclaringType.FullName == HookType) ?? false;
}

static bool HasModManager(string path)
{
    using var asm = AssemblyDefinition.ReadAssembly(path);
    return asm.MainModule.AssemblyReferences.Any(r => r.Name == "UnityModManager");
}

static int Fail(string msg)
{
    Console.Error.WriteLine($"error: {msg}");
    return 1;
}
