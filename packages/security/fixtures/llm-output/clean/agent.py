# Clean near-misses for the R-28 pack: the same jobs, done with validation.
import json
import os
import shlex
import subprocess

import bleach
import jsonschema
from markupsafe import Markup
from openai import OpenAI
from pydantic import BaseModel

client = OpenAI()

SCHEMA = {"type": "object", "properties": {"fields": {"type": "array"}}}


class Extraction(BaseModel):
    fields: list[str]


def extract(document):
    completion = client.chat.completions.create(model="gpt-4o", messages=[])
    return Extraction.model_validate(json.loads(completion.choices[0].message.content))


def extract_two_step(document):
    completion = client.chat.completions.create(model="gpt-4o", messages=[])
    raw = json.loads(completion.choices[0].message.content)
    jsonschema.validate(raw, SCHEMA)
    return raw["fields"]


def extract_with_fallback(document):
    completion = client.chat.completions.create(model="gpt-4o", messages=[])
    try:
        raw = json.loads(completion.choices[0].message.content)
    except json.JSONDecodeError as exc:
        raise ValueError("model returned no JSON") from exc
    return Extraction(**raw)


def extract_direct(document):
    completion = client.chat.completions.create(model="gpt-4o", messages=[])
    return Extraction.model_validate_json(completion.choices[0].message.content)


def structured(document):
    completion = client.beta.chat.completions.parse(
        model="gpt-4o", messages=[], response_format=Extraction
    )
    return completion.choices[0].message.parsed


def store(cursor, doc_id):
    completion = client.chat.completions.create(model="gpt-4o", messages=[])
    summary = completion.choices[0].message.content
    cursor.execute("UPDATE docs SET summary = %s WHERE id = %s", (summary, doc_id))
    with open("/srv/out/summary.txt", "w") as fh:
        fh.write(summary)


def show(prompt):
    completion = client.chat.completions.create(model="gpt-4o", messages=[])
    return Markup(bleach.clean(completion.choices[0].message.content))


def quoted(prompt):
    completion = client.chat.completions.create(model="gpt-4o", messages=[])
    name = shlex.quote(completion.choices[0].message.content)
    subprocess.run(["echo", name])
    os.path.basename(completion.choices[0].message.content)


def not_model_output(user_input, django_field):
    subprocess.run(["git", "log", user_input])
    json.loads(django_field.choices)
    eval("1 + 1")


def dispatch_tool_calls(tools):
    # Tool-call arguments were generated against the declared parameter
    # schema; the dispatcher's signature is the check.
    completion = client.chat.completions.create(model="gpt-4o", messages=[], tools=[])
    for call in completion.choices[0].message.tool_calls or []:
        tools[call.function.name](**json.loads(call.function.arguments))


def checked_by_hand():
    completion = client.chat.completions.create(model="gpt-4o", messages=[])
    verdict = json.loads(completion.choices[0].message.content)
    if not isinstance(verdict, dict) or not isinstance(verdict.get("passed"), bool):
        raise ValueError("verdict without a boolean 'passed'")
    return verdict["passed"]


async def extract_with_schema(gemini, prompt):
    # Structured output: response_schema constrains what the model can emit.
    config = {"response_mime_type": "application/json", "response_schema": SCHEMA}
    response = await gemini.aio.models.generate_content(
        model="gemini-2.5-flash", contents=prompt, config=config
    )
    return json.loads(response.text)
