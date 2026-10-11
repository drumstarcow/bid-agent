# -*- coding: utf-8 -*-
import os
import sys
import tempfile

import pytest

# 独立临时数据库，不污染演示数据；必须在导入 app 之前设置
_TMP_DB = os.path.join(tempfile.mkdtemp(prefix='bidagent_test_'), 'test.sqlite3')
os.environ['BIDAGENT_DB_PATH'] = _TMP_DB
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db  # noqa: E402


@pytest.fixture()
def conn():
    db.initialize()
    with db.connect() as c:
        db.seed(c)
        yield c


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c
