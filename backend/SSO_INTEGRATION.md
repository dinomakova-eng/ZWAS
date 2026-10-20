# Replacing mock authentication

The only authentication integration boundary is `app/identity.py:authenticate_ec_number`. Replace its mock credential lookup with the ZETDC SSO/API call, normalize the result to the existing `Identity` dataclass, and keep JWT issuance in `main.py` unchanged. Store endpoint URLs, client credentials, and signing configuration as environment variables rather than source code.
