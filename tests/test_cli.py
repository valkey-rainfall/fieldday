"""Stage 3 tests: CLI behavior."""

import json

import pytest

from fieldday.cli import main

SNIPPET = """
struct client {
    uint64_t id;
    int fd;
    uint8_t resp;
    void *conn;
};
"""


@pytest.fixture
def cfile(tmp_path):
    p = tmp_path / "client.c"
    p.write_text(SNIPPET)
    return p


def test_default_output_path(cfile, capsys):
    assert main([str(cfile)]) == 0
    out = cfile.parent / "client.svg"
    assert out.exists() and "<svg" in out.read_text()


def test_explicit_output(cfile, tmp_path):
    out = tmp_path / "x.svg"
    assert main([str(cfile), "-o", str(out)]) == 0
    assert out.exists()


def test_stdout_output(cfile, capsys):
    assert main([str(cfile), "-o", "-"]) == 0
    assert "<svg" in capsys.readouterr().out


def test_emit_json(cfile, capsys):
    assert main([str(cfile), "--emit-json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["structs"][0]["name"] == "client"
    assert data["structs"][0]["size"] == 24


def test_json_roundtrip(cfile, tmp_path, capsys):
    main([str(cfile), "--emit-json"])
    jf = tmp_path / "layout.json"
    jf.write_text(capsys.readouterr().out)
    out = tmp_path / "rt.svg"
    assert main(["--from-json", str(jf), "-o", str(out)]) == 0
    assert "resp" in out.read_text()


def test_multi_struct_suffixed(tmp_path):
    p = tmp_path / "two.c"
    p.write_text("struct a { long x; };\nstruct b { int y; };")
    assert main([str(p)]) == 0
    assert (tmp_path / "two_a.svg").exists()
    assert (tmp_path / "two_b.svg").exists()


def test_struct_filter(tmp_path):
    p = tmp_path / "two.c"
    p.write_text("struct a { long x; };\nstruct b { int y; };")
    out = tmp_path / "only.svg"
    assert main([str(p), "--struct", "b", "-o", str(out)]) == 0
    assert out.exists() and not (tmp_path / "two_a.svg").exists()


def test_light_theme_baked(cfile, tmp_path):
    out = tmp_path / "l.svg"
    main([str(cfile), "--theme", "light", "-o", str(out)])
    assert "#ffffff" in out.read_text()


def test_theme_file(cfile, tmp_path):
    tf = tmp_path / "t.json"
    tf.write_text('{"field": "#abcdef"}')
    out = tmp_path / "t.svg"
    main([str(cfile), "--theme", str(tf), "-o", str(out)])
    assert "#abcdef" in out.read_text()


def test_bad_theme_exits(cfile):
    with pytest.raises(SystemExit):
        main([str(cfile), "--theme", "nope"])


def test_bad_theme_key_exits(cfile, tmp_path):
    tf = tmp_path / "t.json"
    tf.write_text('{"wat": "#000"}')
    with pytest.raises(SystemExit, match="unknown theme keys"):
        main([str(cfile), "--theme", str(tf)])


def test_missing_struct_exits(cfile):
    with pytest.raises(SystemExit, match="no struct named"):
        main([str(cfile), "--struct", "wat"])


def test_snippet_error_exits(tmp_path):
    p = tmp_path / "bad.c"
    p.write_text("struct p { wat w; };")
    with pytest.raises(SystemExit, match="Unknown type"):
        main([str(p)])
