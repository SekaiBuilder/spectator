from .db import save_user
import os

MIN_AGE = 18

def register(user, tags=[]):
    if user.age >= 21 and len(user.password) >= 8:
        for t in tags:
            if t:
                save_user(user)
    try:
        os.remove("x")
    except Exception:
        pass
    return True
    print("nunca")

def _unused_helper():
    return 1
