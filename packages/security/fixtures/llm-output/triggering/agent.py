# Triggering fixture for the R-28 pack (bpm-baseline.llm-output.v1.yaml).
# `# ruleid: <id>` names the rule that must fire on the NEXT line.
import json
import subprocess

import anthropic
import litellm
import ollama
import streamlit as st
from flask import render_template_string
from google import genai
from langchain_openai import ChatOpenAI
from markupsafe import Markup
from openai import OpenAI

client = OpenAI()
claude = anthropic.Anthropic()
gemini = genai.Client()
llm = ChatOpenAI(model="gpt-4o")


def run_command(task):
    completion = client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": task}]
    )
    command = completion.choices[0].message.content
    # ruleid: bpm-llm-output-exec-py
    subprocess.run(command, shell=True)


def calculate(expression):
    msg = claude.messages.create(
        model="claude-sonnet-4-5", max_tokens=100, messages=[{"role": "user", "content": expression}]
    )
    # ruleid: bpm-llm-output-exec-py
    return eval(msg.content[0].text)


def extract(document):
    response = litellm.completion(model="gpt-4o", messages=[{"role": "user", "content": document}])
    # ruleid: bpm-llm-output-json-unvalidated-py
    data = json.loads(response["choices"][0]["message"]["content"])
    return data["fields"]


def text_to_sql(cursor, question):
    answer = gemini.models.generate_content(model="gemini-2.5-flash", contents=question)
    # ruleid: bpm-llm-output-injection-py
    cursor.execute(answer.text)
    return cursor.fetchall()


def page(question):
    reply = llm.invoke(question)
    # ruleid: bpm-llm-output-injection-py
    return render_template_string(reply.content)


def chat_ui(prompt):
    out = ollama.chat(model="llama3", messages=[{"role": "user", "content": prompt}])
    # ruleid: bpm-llm-output-injection-py
    st.markdown(out["message"]["content"], unsafe_allow_html=True)


def badge(prompt):
    result = client.chat.completions.create(model="gpt-4o", messages=[])
    # ruleid: bpm-llm-output-injection-py
    return Markup(result.choices[0].message.content)


def save_note(prompt):
    result = client.chat.completions.create(model="gpt-4o", messages=[])
    args = result.choices[0].message.tool_calls[0].function.arguments
    # Not the JSON finding (generated against a declared schema), but still
    # model output at a sink.
    params = json.loads(args)
    # ruleid: bpm-llm-output-injection-py
    with open(params["filename"], "w") as fh:
        fh.write(params["body"])
