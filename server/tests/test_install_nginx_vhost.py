"""
The vhost splice edits the file every site on the droplet is served from, so its
text handling is tested rather than trusted.
"""

import pytest

from deploy.install_nginx_vhost import END_MARKER, START_MARKER, extract_block, splice

FRAGMENT = f"""{START_MARKER}
server {{ server_name authenticator.moates.com.au; }}
{END_MARKER}
"""

OTHER_SITES = """server { server_name gymjunkie.moates.com.au; }

server { server_name vault.moates.com.au; }
"""


def test_extract_block_keeps_the_markers():
    block = extract_block(FRAGMENT)
    assert block.startswith(START_MARKER)
    assert block.endswith(END_MARKER)


def test_extract_block_rejects_a_fragment_without_markers():
    with pytest.raises(SystemExit):
        extract_block("server { server_name authenticator.moates.com.au; }")


def test_splice_appends_when_no_block_is_present():
    result = splice(OTHER_SITES, extract_block(FRAGMENT))

    assert OTHER_SITES in result
    assert result.count(START_MARKER) == 1
    assert "authenticator.moates.com.au" in result


def test_splice_replaces_rather_than_duplicating():
    once = splice(OTHER_SITES, extract_block(FRAGMENT))

    changed = FRAGMENT.replace("authenticator.moates", "authenticator2.moates")
    twice = splice(once, extract_block(changed))

    assert twice.count(START_MARKER) == 1
    assert "authenticator2.moates.com.au" in twice
    assert "authenticator.moates.com.au" not in twice
    # The other sites survive untouched, which is the whole risk being guarded.
    assert OTHER_SITES in twice


def test_splice_is_idempotent():
    once = splice(OTHER_SITES, extract_block(FRAGMENT))
    assert splice(once, extract_block(FRAGMENT)) == once


def test_splice_refuses_a_half_marked_template():
    broken = f"{OTHER_SITES}\n{START_MARKER}\nserver {{ }}\n"
    with pytest.raises(SystemExit):
        splice(broken, extract_block(FRAGMENT))
