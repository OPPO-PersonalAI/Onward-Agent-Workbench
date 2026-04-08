# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

class OutlineFixture:
    def __init__(self, prefix: str) -> None:
        self.prefix = prefix

    def build_label(self, suffix: str) -> str:
        return f"{self.prefix}-{suffix}"


def top_level_helper(value: int) -> int:
    return value * 2


def summarize_values(values: list[int]) -> str:
    fixture = OutlineFixture("outline")
    total = sum(top_level_helper(item) for item in values)
    return fixture.build_label(str(total))
