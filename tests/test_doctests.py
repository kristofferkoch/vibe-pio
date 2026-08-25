"""Doctest gate: every pio_model module's (and the C13 oracle's)
docstring examples run with the suite (`make py`). The package uses
relative imports and runs stdlib-only (in the container too), so pytest's
--doctest-modules file walk cannot import it — instead each module in
MODULES is imported through the conftest sys.path shim and its
DocTestSuite executed here. A module with no doctests fails the gate
(the examples are the usage documentation).
"""

import doctest
import unittest
from types import ModuleType

import hyperequiv
import pytest
from pio_model import asm, disasm, encoding, model, stim, tracefmt

MODULES: tuple[ModuleType, ...] = (encoding, asm, disasm, tracefmt, stim, model, hyperequiv)


@pytest.fixture(params=MODULES, ids=lambda m: m.__name__)
def mod(request: pytest.FixtureRequest) -> ModuleType:
    return request.param


def test_doctests(mod: ModuleType) -> None:
    suite = doctest.DocTestSuite(mod)  # ValueError if the module has none
    result = unittest.TestResult()
    suite.run(result)
    assert result.testsRun > 0
    assert not result.failures, result.failures
    assert not result.errors, result.errors
