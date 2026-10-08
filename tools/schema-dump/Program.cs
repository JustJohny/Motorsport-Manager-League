// Writes schema JSON for the toolkit (src/schema.ts: { root, classes: { name: { base?, fields } } })
// from a game's Assembly-CSharp.dll: every class with its instance fields that FullSerializer can
// write (not static, const or [NonSerialized]), with their declared types.
//
//   schema-dump <Assembly-CSharp.dll> <out.json>
//
// tools/gen-schema.ts does the same from monodis output, but monodis crashes on some modded DLLs
// (FIRE Fantasy 20's). Names follow monodis: nested types "Outer+Inner", IL primitive names.
using System.Text.Json.Nodes;
using Mono.Cecil;

if (args.Length != 2) { Console.Error.WriteLine("usage: schema-dump <Assembly-CSharp.dll> <out.json>"); return 1; }

var prims = new Dictionary<string, string>
{
    ["System.Boolean"] = "bool", ["System.Char"] = "char", ["System.SByte"] = "int8", ["System.Byte"] = "unsigned int8",
    ["System.Int16"] = "int16", ["System.UInt16"] = "unsigned int16", ["System.Int32"] = "int32", ["System.UInt32"] = "unsigned int32",
    ["System.Int64"] = "int64", ["System.UInt64"] = "unsigned int64", ["System.Single"] = "float32", ["System.Double"] = "float64",
    ["System.String"] = "string", ["System.Object"] = "object", ["System.IntPtr"] = "native int", ["System.UIntPtr"] = "native unsigned int",
};

string Name(TypeReference t)
{
    var name = t.Name.Replace("'", "");
    if (t.DeclaringType != null) return Name(t.DeclaringType) + "+" + name;
    return string.IsNullOrEmpty(t.Namespace) ? name : t.Namespace + "." + name;
}

JsonNode Ref(TypeReference t)
{
    switch (t)
    {
        case ArrayType a: return new JsonObject { ["arr"] = Ref(a.ElementType) };
        case GenericParameter g: return new JsonObject { ["g"] = g.Position };
        case GenericInstanceType gi:
        {
            var args = new JsonArray();
            foreach (var a in gi.GenericArguments) args.Add(Ref(a));
            return new JsonObject { ["n"] = Name(gi.ElementType), ["a"] = args };
        }
        case RequiredModifierType rm: return Ref(rm.ElementType);
        case OptionalModifierType om: return Ref(om.ElementType);
    }
    var full = Name(t);
    return prims.TryGetValue(full, out var p) ? new JsonObject { ["p"] = p } : new JsonObject { ["n"] = full };
}

var module = ModuleDefinition.ReadModule(args[0]);
var classes = new JsonObject();
foreach (var type in module.GetTypes())
{
    if (type.Name == "<Module>") continue;
    var def = new JsonObject();
    var fields = new JsonObject();
    foreach (var f in type.Fields)
    {
        if (f.IsStatic || f.IsLiteral || f.IsNotSerialized) continue;
        fields[f.Name.Replace("'", "")] = Ref(f.FieldType);
    }
    def["fields"] = fields;
    if (type.BaseType != null && Name(type.BaseType) != "System.Object") def["base"] = Ref(type.BaseType);
    classes[Name(type)] = def;
}
var schema = new JsonObject { ["root"] = "Game", ["classes"] = classes };
File.WriteAllText(args[1], schema.ToJsonString());
Console.WriteLine($"{classes.Count} classes -> {args[1]}");
return 0;
