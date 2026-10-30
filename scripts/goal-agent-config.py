#!/usr/bin/env python3
"""Render native project agents from their own canonical, hash-bound skills."""

import argparse
import hashlib
import json
from pathlib import Path
import sys
import tomllib


MANIFEST = "goals/assistant-improvement/roles.json"
COORDINATOR_SKILL = ".agents/skills/qq-goal-iteration/SKILL.md"
ROLES = {
    "qq_implementer": {
        "skill": ".agents/skills/qq-assistant-implement/SKILL.md",
        "description": "Implement a bounded QQ assistant product change; preserve frozen evaluation evidence and leave grading to an independent evaluator.",
        "core": "You are the project implementation specialist. Follow the canonical implementation skill embedded below. Own only the coordinator-authorized product task; return actual checks and artifacts without self-grading conversational quality.",
    },
    "qq_evaluator": {
        "skill": ".agents/skills/qq-assistant-evaluate/SKILL.md",
        "description": "Independently review complete actual QQ assistant outputs from an inline blinded packet using its supplied rubric and source evidence.",
        "core": "You are the independent project evaluator. Follow the canonical evaluation skill embedded below. Work only from the supplied inline blinded packet. Do not call tools or retrieve implementation, memory, or reference material. Return the requested actual review envelope, leaving unsupported judgments uncertain or ungraded.",
        "features": {"shell_tool": False, "apps": False, "plugins": False, "memories": False, "request_permissions_tool": False},
    },
    "qq_diagnostician": {
        "skill": ".agents/skills/qq-assistant-diagnose/SKILL.md",
        "description": "Read preserved QQ assistant replay diagnostics and source to locate the first supported cause of an observed failure; propose a discriminating next check.",
        "core": "You are the project failure diagnostician. Follow the canonical diagnosis skill embedded below. Use shell only for bounded non-mutating reads; do not edit, execute new replay/provider calls, or decide acceptance. Read-only behavior is a role instruction, not an operating-system permission guarantee.",
        "features": {"shell_tool": True, "apps": False, "plugins": False, "memories": False, "request_permissions_tool": False},
    },
}
# These are inherited security/provider settings, never per-role authority.
FORBIDDEN_KEYS = {
    "approval_policy", "approvals_reviewer", "sandbox", "sandbox_mode",
    "sandbox_workspace_write", "permissions", "permission_profile",
    "model", "model_provider", "model_providers", "mcp_servers", "hooks",
    "network_access", "shell_environment_policy",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def project_path(root, relative):
    if not isinstance(relative, str) or Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError(f"Path must stay inside project root: {relative}")
    candidate = root / relative
    if not candidate.resolve().is_relative_to(root):
        raise ValueError(f"Path escapes project root: {relative}")
    return candidate


def exact_keys(value, required, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    unknown = set(value) - set(required)
    missing = set(required) - set(value)
    if unknown:
        raise ValueError(f"{label} has unknown keys: {', '.join(sorted(unknown))}")
    if missing:
        raise ValueError(f"{label} is missing keys: {', '.join(sorted(missing))}")


def load_manifest(root):
    manifest = json.loads(project_path(root, MANIFEST).read_text(encoding="utf-8"))
    exact_keys(manifest, {"version", "coordinator", "agents"}, "Role manifest")
    if manifest["version"] != 1:
        raise ValueError("Role manifest version must be 1")
    exact_keys(manifest["coordinator"], {"skill"}, "Coordinator")
    if manifest["coordinator"]["skill"] != COORDINATOR_SKILL:
        raise ValueError("Coordinator must use its canonical skill path")
    read_skill(root, COORDINATOR_SKILL)
    exact_keys(manifest["agents"], ROLES, "Agents")
    for name, agent in manifest["agents"].items():
        exact_keys(agent, {"config", "skill"}, name)
        if agent["skill"] != ROLES[name]["skill"]:
            raise ValueError(f"{name} must use its canonical skill path")
        if agent["config"] != f".codex/agents/{name}.toml":
            raise ValueError(f"{name} must use its canonical native config path")
        project_path(root, agent["config"])
    return manifest


def read_skill(root, relative):
    raw = project_path(root, relative).read_bytes()
    text = raw.decode("utf-8")
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise ValueError(f"Canonical skill lacks frontmatter: {relative}")
    end = next((index for index in range(1, len(lines)) if lines[index].strip() == "---"), None)
    if end is None:
        raise ValueError(f"Canonical skill has unclosed frontmatter: {relative}")
    metadata = "".join(lines[1:end])
    expected_name = Path(relative).parent.name
    if f"name: {expected_name}\n" not in metadata or not any(line.startswith("description: ") for line in lines[1:end]):
        raise ValueError(f"Canonical skill has invalid name/description: {relative}")
    body = "".join(lines[end + 1:]).strip()
    if not body:
        raise ValueError(f"Canonical skill has no instructions: {relative}")
    return raw, body


def toml_string(value):
    # JSON basic-string escaping is compatible with TOML; TOML also requires DEL escaped.
    return json.dumps(value, ensure_ascii=False).replace("\x7f", "\\u007f")


def forbidden_keys(value, prefix=""):
    if not isinstance(value, dict):
        return []
    found = []
    for key, nested in value.items():
        location = f"{prefix}.{key}" if prefix else key
        if key in FORBIDDEN_KEYS:
            found.append(location)
        if isinstance(nested, dict):
            found.extend(forbidden_keys(nested, location))
        elif isinstance(nested, list):
            for index, item in enumerate(nested):
                found.extend(forbidden_keys(item, f"{location}[{index}]"))
    return found


def validate_toml(text, relative):
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise ValueError(f"Invalid TOML in {relative}: {error}") from error
    forbidden = forbidden_keys(parsed)
    if forbidden:
        raise ValueError(f"Forbidden inherited setting in {relative}: {', '.join(forbidden)}")
    return parsed


def render(name, agent, skill_raw, body):
    role = ROLES[name]
    instructions = (
        f"{role['core']}\n\nCanonical skill: {agent['skill']}\n"
        f"Canonical skill SHA-256: {digest(skill_raw)}\n"
        "The following is the complete canonical skill body, embedded so it is consumed without tool access.\n\n"
        f"{body}\n"
    )
    lines = [
        "# Generated by scripts/goal-agent-config.py; edit the canonical skill, then regenerate.",
        "# Model, provider, permissions, approval review, hooks, and MCP settings inherit from the parent.",
        f"name = {toml_string(name)}",
        f"description = {toml_string(role['description'])}",
        f"developer_instructions = {toml_string(instructions)}",
        "", "[skills]", "include_instructions = false", "", "[skills.bundled]", "enabled = false",
    ]
    if "features" in role:
        lines.extend(["", "[features]"])
        lines.extend(f"{key} = {str(value).lower()}" for key, value in role["features"].items())
    return "\n".join(lines) + "\n"


def run(root, action):
    manifest = load_manifest(root)
    outputs = []
    # Prepare and validate all artifacts before writing any of them.
    for name, agent in manifest["agents"].items():
        raw, body = read_skill(root, agent["skill"])
        content = render(name, agent, raw, body)
        parsed = validate_toml(content, agent["config"])
        if parsed["name"] != name or not all(parsed.get(key) for key in ("description", "developer_instructions")):
            raise ValueError(f"Invalid native agent identity: {name}")
        outputs.append((name, agent, raw, content))
    errors = []
    identities = []
    for name, agent, raw, content in outputs:
        target = project_path(root, agent["config"])
        if action == "generate":
            target.parent.mkdir(parents=True, exist_ok=True)
            # Recheck after directory creation; symlink ancestors must stay in the selected root.
            target = project_path(root, agent["config"])
            target.write_text(content, encoding="utf-8")
        elif not target.is_file():
            errors.append(f"{name}: generated config missing ({agent['config']})")
        else:
            current = target.read_text(encoding="utf-8")
            validate_toml(current, agent["config"])
            if current != content:
                errors.append(f"{name}: generated config stale ({agent['config']}); run generate")
        identities.append({"name": name, "config": agent["config"], "skill": agent["skill"], "skill_sha256": digest(raw), "config_sha256": digest(content.encode("utf-8"))})
    if errors:
        raise ValueError("; ".join(errors))
    return {"version": 1, "status": "generated" if action == "generate" else "current", "agents": identities}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "generate"), help="Check canonical embeddings or regenerate the three native TOML files")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="Selected project checkout (also supports isolated test copies)")
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.root.resolve(), args.action), indent=2))
    except (OSError, ValueError) as error:
        print(f"goal-agent-config: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
