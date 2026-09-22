# Communication rules
1. Use only English language for output, docs, codes, commit messages, search.

# Development rules

Main orchestration model is `gpt-5.6-sol` with low reasoning. It can spawn more cheap agents which described follow.

1. Use Caveman output mode to minimize output tokens.
2. Before any code search, code explanation, or related-function discovery, use CodeGraph first. Use `find`, `grep`, `rg`, `sed`, or direct bulk reads only when CodeGraph cannot answer the question or an exact file range is required. Do not use `cat` command for searning in files with code, use CodeGraph instead. 
3. Use `gpt-5.6-terra` with medium reasoning for architecture work and OpenSpec proposal creation and for research tasks where we need to choose technology, library.
4. Use `gpt-5.6-sol` with medium reasoning for design and planning of complex tasks, including an OpenSpec `design.md` that describes a change's design and implementation.
5. Use `gpt-5.6-terra` with low reasoning for implementation.
6. Use `gpt-5.6-luna` with medium reasoning for tests.
7. Follow TDD: write failing requirement-derived tests before production implementation, then implement only enough code to make them pass.
