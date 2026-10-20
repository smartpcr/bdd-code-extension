// Command go-module-zip writes one version of a Go module in the layout the
// module proxy protocol serves (list, .info, .mod, .zip), so a consumer can
// install it with GOPROXY=file:///<out> exactly as it would from
// proxy.golang.org, before any tag exists (docs/packages, DEC-P09, E3). The zip
// is made by golang.org/x/mod/zip, the code the go command itself checks a
// module zip with.
//
//	go run . -dir ../../runtimes/go -version v0.7.0 -out ../../artifacts/feeds/goproxy
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/mod/modfile"
	"golang.org/x/mod/module"
	"golang.org/x/mod/zip"
)

func main() {
	dir := flag.String("dir", "", "the module's folder, where its go.mod is")
	version := flag.String("version", "", "the version to write, v<x.y.z>")
	out := flag.String("out", "", "the GOPROXY folder to write into")
	flag.Parse()
	if err := write(*dir, *version, *out); err != nil {
		fmt.Fprintln(os.Stderr, "go-module-zip:", err)
		os.Exit(1)
	}
}

func write(dir, version, out string) error {
	if dir == "" || version == "" || out == "" {
		return fmt.Errorf("-dir, -version and -out are all needed")
	}
	goMod, err := os.ReadFile(filepath.Join(dir, "go.mod"))
	if err != nil {
		return err
	}
	path := modfile.ModulePath(goMod)
	if path == "" {
		return fmt.Errorf("%s/go.mod names no module", dir)
	}
	held := module.Version{Path: path, Version: version}
	if err := module.Check(path, version); err != nil {
		return err
	}
	escaped, err := module.EscapePath(path)
	if err != nil {
		return err
	}
	at := filepath.Join(out, filepath.FromSlash(escaped), "@v")
	if err := os.MkdirAll(at, 0o755); err != nil {
		return err
	}
	archive, err := os.Create(filepath.Join(at, version+".zip"))
	if err != nil {
		return err
	}
	if err := zip.CreateFromDir(archive, held, dir); err != nil {
		archive.Close()
		return err
	}
	if err := archive.Close(); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(at, version+".mod"), goMod, 0o644); err != nil {
		return err
	}
	info, _ := json.Marshal(map[string]string{"Version": version, "Time": time.Now().UTC().Format(time.RFC3339)})
	if err := os.WriteFile(filepath.Join(at, version+".info"), info, 0o644); err != nil {
		return err
	}
	listed, _ := os.ReadFile(filepath.Join(at, "list"))
	versions := strings.Fields(string(listed))
	if !contains(versions, version) {
		versions = append(versions, version)
	}
	if err := os.WriteFile(filepath.Join(at, "list"), []byte(strings.Join(versions, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	fmt.Printf("%s@%s -> %s\n", path, version, at)
	return nil
}

func contains(list []string, wanted string) bool {
	for _, item := range list {
		if item == wanted {
			return true
		}
	}
	return false
}
