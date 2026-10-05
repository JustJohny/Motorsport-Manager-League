// Patches MM's Assembly-CSharp.dll so SessionManager.StartSession calls LeaguePatch.Hooks.OnSessionStart.
//
//   league-patch <MM_Data/Managed> <LeaguePatch.dll>   patch (from the .orig backup if there is one)
//   league-patch <MM_Data/Managed> --restore           put the original back
//   league-patch <MM_Data/Managed> --status            say whether the game is patched
//
// The original is kept as Assembly-CSharp.dll.orig and every patch starts from it, so patching twice
// never stacks calls.
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

if (args[1] == "--status")
{
    Console.WriteLine(IsPatched(dll) ? "patched" : "not patched");
    return 0;
}
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
var hookDef = hookAsm.MainModule.GetType(HookType)?.Methods.FirstOrDefault(m => m.Name == HookMethod)
    ?? throw new Exception($"{HookType}.{HookMethod} not found in {hookDll}");

using (var asm = AssemblyDefinition.ReadAssembly(orig, new ReaderParameters { AssemblyResolver = resolver }))
{
    var module = asm.MainModule;
    var start = module.GetType("SessionManager")?.Methods.FirstOrDefault(m => m.Name == "StartSession" && !m.HasParameters)
        ?? throw new Exception("SessionManager.StartSession() not found; is this MM 1.53?");
    var call = module.ImportReference(hookDef);
    var il = start.Body.GetILProcessor();
    // Before every return, so the hook runs once the session is green.
    foreach (var ret in start.Body.Instructions.Where(i => i.OpCode == OpCodes.Ret).ToList())
    {
        var load = il.Create(OpCodes.Ldarg_0);
        il.InsertBefore(ret, load);
        il.InsertBefore(ret, il.Create(OpCodes.Call, call));
        // Branches that jumped to the return now land on the hook call first.
        foreach (var i in start.Body.Instructions.Where(i => i.Operand == ret && i != load)) i.Operand = load;
    }
    asm.Write(dll);
}
File.Copy(hookDll, Path.Combine(managed, "LeaguePatch.dll"), overwrite: true);
Console.WriteLine($"patched {Target}: SessionManager.StartSession calls {HookType}.{HookMethod}");
return 0;

static bool IsPatched(string path)
{
    using var asm = AssemblyDefinition.ReadAssembly(path);
    var start = asm.MainModule.GetType("SessionManager")?.Methods.FirstOrDefault(m => m.Name == "StartSession" && !m.HasParameters);
    return start?.Body.Instructions.Any(i => i.Operand is MethodReference m && m.DeclaringType.FullName == HookType) ?? false;
}

static int Fail(string msg)
{
    Console.Error.WriteLine($"error: {msg}");
    return 1;
}
