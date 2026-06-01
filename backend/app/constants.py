"""Shared constants for the app domain layer."""

# Key under which a node's stable cross-version lineage id is stored in
# ProcessNode.properties (SP-4 version control). Seeded with the node's own
# id on first creation, inherited unchanged on copy.
LINEAGE_KEY = "_lineage_id"
