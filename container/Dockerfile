# vibe-pio toolchain image (podman/docker).
#
# Base: Debian trixie (13) slim. Distro packages provide iverilog >= 12,
# z3, make/git/python3/curl/wget. Two exceptions, both built from pinned
# source and installed under /usr/local:
#
#   * yosys: Debian's yosys package is built WITHOUT the ilang frontend
#     (no `read_ilang`/`write_ilang`), which SymbiYosys depends on to pass
#     designs between yosys invocations — so sby fails with
#     "No such command: read_ilang". We build yosys v0.68 from source.
#
#   * boolector: Debian's "boolector" package is 1.5.118 (2012) and lacks
#     the `btormc` binary sby needs. We build release 3.2.4 from source.
#
# SymbiYosys itself is a Python install from source, pinned to master
# commit b1a1e98cba941ec8433f8dc27f416cd7bb7f14be (the newest release tag,
# yosys-0.47, still emits `read_ilang`, which yosys >= 0.68 removed in
# favour of `read_rtlil`).
#
# All source builds happen in a single RUN with the build toolchain
# installed and purged in the same layer, so compilers never bloat the
# final image.
#
# Build:  docker build -t vibe-pio:latest container/
#      or  podman build -t vibe-pio:latest container/

FROM debian:trixie-slim

ARG YOSYS_TAG=v0.68
ARG YOSYS_COMMIT=38e001a6ff74ca434bf4cc02c053f53619160ab0
ARG SBY_COMMIT=b1a1e98cba941ec8433f8dc27f416cd7bb7f14be
ARG BOOSTECTOR_TAG=3.2.4
ARG BOOSTECTOR_COMMIT=393cdfba3735d334bb4e6525500b8a0280dd41e6

RUN apt-get update && apt-get install -y --no-install-recommends \
        iverilog \
        z3 \
        python3-click \
        tcl8.6 \
        make \
        git \
        python3 \
        python3-pip \
        curl \
        wget \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential clang bison flex libreadline-dev gawk \
        tcl-dev libffi-dev graphviz pkg-config zlib1g-dev \
        cmake autoconf \
    \
    # ---- yosys (source, pinned; CMake build since 0.68) -----------------
    && git clone --branch ${YOSYS_TAG} --depth 1 --recurse-submodules \
           --shallow-submodules \
           https://github.com/YosysHQ/yosys /tmp/yosys \
    && cd /tmp/yosys \
    && test "$(git rev-parse HEAD)" = "${YOSYS_COMMIT}" \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j"$(nproc)" \
    && cmake --install build \
    && cd /tmp && rm -rf /tmp/yosys \
    \
    # ---- boolector + btormc (source, pinned) --------------------------
    && git clone --branch ${BOOSTECTOR_TAG} --depth 1 \
           https://github.com/Boolector/boolector /tmp/boolector \
    && cd /tmp/boolector \
    && test "$(git rev-parse HEAD)" = "${BOOSTECTOR_COMMIT}" \
    && ./contrib/setup-cadical.sh && ./contrib/setup-btor2tools.sh \
    && ./configure.sh --prefix /usr/local \
    && cmake --build build -j"$(nproc)" \
    && cmake --install build \
    && cd /tmp && rm -rf /tmp/boolector \
    \
    # ---- SymbiYosys (source, pinned to master commit; the latest release
    # ---- tag yosys-0.47 still uses `read_ilang`, removed in yosys 0.68) --
    && git clone https://github.com/YosysHQ/sby /tmp/sby \
    && cd /tmp/sby \
    && git checkout ${SBY_COMMIT} \
    && make install \
    && cd /tmp && rm -rf /tmp/sby \
    \
    # ---- purge build toolchain (same layer: no size cost) --------------
    && apt-get purge -y build-essential clang bison flex libreadline-dev \
           gawk tcl-dev libffi-dev graphviz pkg-config zlib1g-dev \
           cmake autoconf \
    && apt-get autoremove -y \
    # restore runtime libs the purges above removed but yosys links against
    && apt-get install -y --no-install-recommends tcl8.6 \
    && rm -rf /var/lib/apt/lists/* /tmp/*

WORKDIR /work

# Non-interactive, deterministic locale for tool output parsing.
ENV LC_ALL=C.UTF-8

CMD ["/bin/bash"]
