"""A1111-style CLIP chunking on top of ComfyUI's tokenizer.

ComfyUI cuts prompts into 75-token chunks wherever the 75th token falls,
so a tag can end up split across two chunks. A1111 instead, when a chunk
fills up, backtracks to the last comma (if it's within
COMMA_BACKTRACK tokens) and starts the next chunk from there, and treats
BREAK as an explicit chunk boundary. This module re-applies that logic to
the (token, weight) lists ComfyUI's own tokenizer produces, so weights,
embeddings and escaping all behave exactly as in core CLIPTextEncode -
only the chunk boundaries move.

Shared by the Smart Chunk encode node (nodes.py) and the token counter
endpoint (server.py), so the counter shows exactly what the node encodes.
"""
import re

CHUNK_LENGTH = 75
COMMA_BACKTRACK = 20  # A1111's default for comma_padding_backtrack
COMMA_TOKEN = 267  # ",</w>" in the CLIP BPE vocab (shared by clip_l / clip_g)

_BREAK = re.compile(r"\s*\bBREAK\b\s*")


def _is_comma(tok):
    # Embedding vectors come through as tensors, not ints - never a comma.
    return isinstance(tok[0], int) and tok[0] == COMMA_TOKEN


def split_break(text):
    return _BREAK.split(text)


def flatten(batches):
    """ComfyUI batches (with word ids) -> flat [(token, weight)] of prompt
    content only. Start/end/padding tokens are the ones with word id 0."""
    return [(t, w) for batch in batches for t, w, word_id in batch if word_id != 0]


def rechunk(segments):
    """segments: list of flat [(token, weight)] lists, one per BREAK-separated
    part. Returns a list of chunks (each <= CHUNK_LENGTH content tokens)."""
    chunks = []
    for seg in segments:
        chunk = []
        last_comma = -1
        for tok in seg:
            if len(chunk) == CHUNK_LENGTH:
                if not _is_comma(tok) and last_comma != -1 and len(chunk) - last_comma <= COMMA_BACKTRACK:
                    # Move the partial tag after the last comma into the next chunk.
                    split_at = last_comma + 1
                    chunks.append(chunk[:split_at])
                    chunk = chunk[split_at:]
                else:
                    chunks.append(chunk)
                    chunk = []
                last_comma = -1
            if _is_comma(tok):
                last_comma = len(chunk)
            chunk.append(tok)
        if chunk or not chunks:
            chunks.append(chunk)
    return chunks


def to_batches(chunks, sub_tokenizer):
    """Wraps content chunks back into full CLIP batches (start + content +
    end + padding to max_length), using that sub-tokenizer's own specials."""
    st = sub_tokenizer
    batches = []
    for chunk in chunks:
        batch = []
        if st.start_token is not None:
            batch.append((st.start_token, 1.0))
        batch.extend(chunk)
        if st.end_token is not None:
            batch.append((st.end_token, 1.0))
        if st.pad_to_max_length and len(batch) < st.max_length:
            pad = [(st.pad_token, 1.0)] * (st.max_length - len(batch))
            batch = pad + batch if st.pad_left else batch + pad
        batches.append(batch)
    return batches


def smart_tokenize(clip, text):
    """Drop-in replacement for clip.tokenize(text) with A1111 chunking. Any
    text encoder that isn't a CLIP-style sub-tokenizer (e.g. T5) keeps
    ComfyUI's normal tokenization."""
    per_segment = [clip.tokenize(seg, return_word_ids=True) for seg in split_break(text)]
    out = {}
    for key in per_segment[0]:
        sub = getattr(clip.tokenizer, "clip_" + key, None)
        if sub is None or getattr(sub, "max_length", None) != CHUNK_LENGTH + 2:
            out[key] = clip.tokenize(text)[key]
            continue
        chunks = rechunk([flatten(tokens[key]) for tokens in per_segment])
        out[key] = to_batches(chunks, sub)
    return out
