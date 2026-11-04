"""Second half of package-runtime.sh: headers, libraries, flags.json,
undefined.txt, licences, manifest.json and the .zip. Run by that script, which
has compiled rt.a and left the dependency list and the driver's link line in
$STAGE/probe; everything comes in through the environment.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ENV = os.environ


def win(p):
    """A Git Bash path (/c/...) as Python on Windows needs it."""
    p = str(p)
    if os.name == "nt" and re.match(r"^/[a-zA-Z]/", p):
        p = p[1].upper() + ":" + p[2:]
    return Path(p)


PKG = win(ENV["PKG"])
STAGE = win(ENV["STAGE"])
SDK = win(ENV["SDK"])
GAME = win(ENV["GAME"])
RT = win(ENV["RT"])
HERE = GAME / "web" / "wasm"
CC = str(SDK / "bin" / "clang")

# Where the kit keeps what it takes from wasi-sdk: the same relative layout,
# so --sysroot and -resource-dir find it as they find the SDK's.
SYSROOT = SDK / "share" / "wasi-sysroot"
RESOURCE = next((SDK / "lib" / "clang").iterdir())      # lib/clang/<major>
KIT_SYSROOT = PKG / "sysroot"
KIT_RESOURCE = PKG / "clang"

# What tools/recomp defines besides the lifted functions: they are the
# generated code's side of the link, not something the runtime is missing.
# (xbe_entry_point is the entry function's label, tools/disasm/labels.py.)
GENERATED = re.compile(r"^(sub_[0-9A-Fa-f]{8}|xbe_entry_point|recomp_(lookup|call_all|dispatch_init|"
                       r"dispatch_flat_bytes|get_count))$")


def norm(p):
    return Path(os.path.normcase(os.path.normpath(str(win(p)))))


def under(p, root):
    try:
        norm(p).relative_to(norm(root))
        return True
    except ValueError:
        return False


def rel_to(p, root):
    return Path(os.path.normpath(str(win(p)))).relative_to(Path(os.path.normpath(str(win(root)))))


def driver_tokens(line):
    """The arguments of one command line clang -### printed (each quoted)."""
    return [m.group(1).replace('\\"', '"').replace("\\\\", "\\")
            for m in re.finditer(r'"((?:[^"\\]|\\.)*)"', line)]


def copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)


def copy_text(src, dst):
    """A text file with LF line ends, whatever the checkout's: the same
    sources make the same kit on every machine."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(Path(src).read_bytes().replace(b"\r\n", b"\n"))


def templ(args, subs):
    """Replace concrete paths in an argument list by ${NAME} placeholders."""
    out = []
    for a in args:
        for real, name in subs:
            for form in {real, real.replace("\\", "/"), real.replace("/", "\\")}:
                a = a.replace(form, name)
        # Inside the kit, paths are the same everywhere: forward slashes.
        out.append(a.replace("\\", "/") if "${" in a else a)
    return out


def main():
    # Headers the generated C reads, from the probe's dependency list.
    deps = (STAGE / "probe" / "deps.mk").read_text().replace("\\\n", " ")
    deps = deps.split(":", 1)[1] if ".o:" in deps else deps
    deps = re.findall(r"(?:[A-Za-z]:)?[^\s]+\.h\b", deps)
    headers = []
    for d in deps:
        if under(d, PKG / "include"):
            continue
        if under(d, RESOURCE / "include"):
            dst = KIT_RESOURCE / "include" / rel_to(d, RESOURCE / "include")
        elif under(d, SYSROOT / "include"):
            dst = KIT_SYSROOT / "include" / rel_to(d, SYSROOT / "include")
        else:
            sys.exit(f"header outside wasi-sdk and the kit: {d}")
        copy(win(d), dst)
        headers.append(dst)
    print(f"{len(headers)} wasi-sdk headers")

    # Libraries: what the driver's wasm-ld line names.
    link = (STAGE / "probe" / "link.txt").read_text().strip().splitlines()[-1]
    toks = driver_tokens(link)
    libdirs = [win(t[2:]) for t in toks if t.startswith("-L")]
    libs = []
    for t in toks[1:]:
        if t.startswith("-l"):
            name = f"lib{t[2:]}.a"
            src = next((d / name for d in libdirs if (d / name).is_file()), None)
            if src is None:
                sys.exit(f"{t}: not found in {libdirs}")
        elif re.search(r"\.(o|a)$", t) and under(t, SDK):
            src = win(t)
        else:
            continue
        if under(src, RESOURCE):
            dst = KIT_RESOURCE / rel_to(src, RESOURCE)
        else:
            dst = KIT_SYSROOT / rel_to(src, SYSROOT)
        copy(src, dst)
        libs.append(dst)
    print(f"{len(libs)} libraries: {' '.join(p.name for p in libs)}")

    # The command lines. Driver form: what build.sh runs, pointed at the kit.
    # cc1 / wasm-ld form: what that driver runs, for a host with no driver
    # (a browser runs cc1 and wasm-ld itself, and cannot spawn processes).
    kit = ["--sysroot=" + str(KIT_SYSROOT), "-resource-dir=" + str(KIT_RESOURCE)]
    cflags = ENV["WASM_CFLAGS_COMMON"].split()
    compile_args = cflags + kit + ["-include", str(PKG / "include" / "wasm_compat.h"),
                                   "-I" + str(PKG / "include")]
    gen, src, obj = STAGE / "probe" / "GEN", STAGE / "probe" / "GEN" / "SRC.c", STAGE / "probe" / "OBJ.o"
    gen.mkdir(parents=True, exist_ok=True)
    src.write_text("int x;\n")
    obj.write_bytes(b"")        # the driver checks its inputs exist, even for -###
    cwd = os.getcwd()
    r = subprocess.run([CC, *compile_args, "-I" + str(gen), "-c", str(src), "-o", str(obj), "-###"],
                       capture_output=True, text=True, check=True)
    cc1 = driver_tokens([l for l in r.stderr.splitlines() if '"-cc1"' in l][0])[1:]
    subs = [(str(PKG), "${PKG}"), (str(src), "${SRC}"), (str(obj), "${OBJ}"), (str(gen), "${GEN}"),
            ("SRC.c", "${SRC_NAME}"), (cwd, "${CWD}")]
    ldflags = ENV["WASM_LDFLAGS"].split()
    link_args = ["--target=wasm32-wasip1-threads", "-pthread"] + kit
    r = subprocess.run([CC, *link_args, str(obj), str(PKG / "lib" / "rt.a"), "-o", str(STAGE / "OUT.wasm"),
                        *ldflags, "-Wl,--allow-undefined", "-Wl,--error-limit=0", "-###"],
                       capture_output=True, text=True, check=True)
    wasm_ld = driver_tokens(r.stderr.strip().splitlines()[-1])[1:]
    wasm_ld = ["${OBJS}" if a == str(obj) else a for a in wasm_ld]
    subs_ld = [(str(PKG), "${PKG}"), (str(STAGE / "OUT.wasm"), "${OUT}")]
    version = subprocess.run([CC, "--version"], capture_output=True, text=True).stdout.splitlines()[0]
    flags = {
        "kit": ENV["NAME"],
        "placeholders": {
            "${PKG}": "this folder",
            "${GEN}": "the folder with the generated C's own header, recomp_funcs.h",
            "${SRC}, ${OBJ}, ${SRC_NAME}": "one generated .c file (after tools.recomp.store_form), its object, and its file name",
            "${OBJS}": "every generated object, in name order (build.sh links gen/*.o)",
            "${OUT}": "the module (atv2.wasm)",
            "${CWD}": "the compiler's working folder (no effect on the object without -g)",
        },
        "clang": version,
        "wasiSdk": (SDK / "VERSION").read_text().split()[0] if (SDK / "VERSION").is_file() else None,
        "compile": {
            "driver": templ(compile_args + ["-I" + str(gen), "-c", str(src), "-o", str(obj)], subs),
            "cc1": templ(cc1, subs),
        },
        "link": {
            "driver": templ(link_args, subs_ld) + ["${OBJS}", "${PKG}/lib/rt.a", "-o", "${OUT}"] + ldflags
                      + ["-Wl,--allow-undefined", "-Wl,--error-limit=0"],
            "wasmLd": templ(wasm_ld, subs_ld),
            "then": ["llvm-strip", "--strip-debug", "${OUT}", "-o", "${OUT}"],
            "note": "build.sh links the same arguments with the runtime objects in its own build-wasm/rt.a; "
                    "the module imports what undefined.txt lists from \"env\" (--allow-undefined), and the page stubs it.",
        },
        "memory": {
            "initialPages": int(ENV["WASM_INITIAL_MEMORY"]) // 65536,
            "maximumPages": int(ENV["WASM_MAX_MEMORY"]) // 65536,
            "globalBase": int(ENV["WASM_GLOBAL_BASE"], 0),
            "stackSize": int(ENV["WASM_STACK_SIZE"]),
            "shared": True,
        },
    }
    (PKG / "flags.json").write_text(json.dumps(flags, indent=2) + "\n", newline="\n")

    # What the runtime leaves undefined, from a link of every runtime object
    # (build.sh's trial link, without the generated code).
    errs = (STAGE / "probe" / "all.err").read_text(errors="replace")
    undefined = sorted({m.group(1) for m in re.finditer(r"undefined symbol: (\S+)", errs)
                        if not GENERATED.match(m.group(1))})
    (PKG / "undefined.txt").write_text("".join(u + "\n" for u in undefined), newline="\n")
    print(f"{len(undefined)} undefined symbols: {' '.join(undefined)}")

    # Licences.
    copy_text(GAME / "LICENSE", PKG / "LICENSE")
    copy_text(RT / "LICENSE", PKG / "licenses" / "xboxrecomp-LICENSE")
    copy_text(RT / "NOTICE", PKG / "licenses" / "xboxrecomp-NOTICE")
    copy_text(RT / "LICENSES" / "LGPL-2.1.txt", PKG / "licenses" / "LGPL-2.1.txt")
    for f in sorted((HERE / "licenses").glob("*.txt")):
        copy_text(f, PKG / "licenses" / f.name)
    tp = (HERE / "runtime-THIRD-PARTY.md").read_text()      # (text mode: LF, whatever the checkout)
    (PKG / "THIRD-PARTY.md").write_text(tp.replace("@KIT@", ENV["NAME"]).replace("@ATV@", ENV["ATV_COMMIT"])
                                        .replace("@XR@", ENV["XR_COMMIT"]).replace("@SDK@", str(flags["wasiSdk"]))
                                        .replace("@CLANG@", version), newline="\n")

    # Manifest, then the zip (fixed times and order: the same kit zips to
    # the same bytes).
    files = sorted(p for p in PKG.rglob("*") if p.is_file())
    manifest = {
        "kit": ENV["NAME"],
        "atvrecomp": ENV["ATV_COMMIT"],
        "xboxrecomp": ENV["XR_COMMIT"],
        "dirty": bool(ENV.get("DIRTY")),
        "wasiSdk": flags["wasiSdk"],
        "clang": version,
        "files": [{"path": p.relative_to(PKG).as_posix(), "size": p.stat().st_size,
                   "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files],
    }
    (PKG / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", newline="\n")
    files = sorted(p for p in PKG.rglob("*") if p.is_file())
    with zipfile.ZipFile(str(PKG) + ".zip", "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            info = zipfile.ZipInfo(f"{ENV['NAME']}/{p.relative_to(PKG).as_posix()}", (1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, p.read_bytes(), compresslevel=9)
    total = sum(p.stat().st_size for p in files)
    print(f"{len(files)} files, {total / 2**20:.2f} MB; zip {os.path.getsize(str(PKG) + '.zip') / 2**20:.2f} MB")


if __name__ == "__main__":
    main()
