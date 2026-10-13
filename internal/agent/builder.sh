set -eu
case "$(uname -m)" in
  x86_64|amd64)
    native=amd64
    nix=x86_64-unknown-linux-musl; rail=x86_64-unknown-linux-musl; pk=linux
    nix_archive=0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6; nix_binary=c3b5165797767ba461ffdf10628913a3459f0331ba887e1a514cc0ef8dce3512
    rail_archive=728407f5cdb9e9bc1cdd07f568419344a20e71b0a5a9fd90a9cfbaca0a6c94f7; rail_binary=4f27a5ad95d146b291eb967cbb7bb85758ac79be7425c7417fa289339feaaf4a
    pk_archive=dc0ee1e931cf8a106d7555a01a214864f9acb60b77adf15d69b74df4404758e9; pk_binary=2f85c3ec624f73f2d3c4a680a2c48fe6755197844730cc4ea5ed05f950fe05a3
    ;;
  aarch64|arm64)
    native=arm64
    nix=aarch64-unknown-linux-musl; rail=arm64-unknown-linux-musl; pk=linux-arm64
    nix_archive=912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39; nix_binary=e528215fc8e1a15672cdeb19734fca4432d085f353d9d77712adc41ace980316
    rail_archive=42eb3fa68e38f44be3610a7d74f714ec0d808d70c105fbe35e053b6e6cfb20be; rail_binary=a11c65a6cd293c4d6b11c53aa6752810d2e31c11f1410e5f23a7329601cd3af4
    pk_archive=091ccb213823656c727731537ef8f1000eb4dc3ec61641506653e7f9d6da0c5e; pk_binary=b430c857e8fb543167e44a189d4b39df1e4d585a7052a24d3d5af9b5df941c3b
    ;;
  *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
sha() {
  sha256sum "$1" | cut -d " " -f 1
}
fetch() {
  if [ -f "/tools/$1" ] && [ "$(sha "/tools/$1")" = "$5" ]; then
    return 0
  fi
  echo "Downloading $1..."
  tmp="/tools/.tmp-$1"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  wget -qO "$tmp/archive" "$2"
  if [ "$(sha "$tmp/archive")" != "$4" ]; then
    rm -rf "$tmp"
    echo "Checksum mismatch for the downloaded $1 archive (expected sha256 $4), refusing to run it." >&2
    exit 1
  fi
  tar -xzf "$tmp/archive" -C "$tmp"
  if [ ! -f "$tmp/$3" ] || [ "$(sha "$tmp/$3")" != "$5" ]; then
    rm -rf "$tmp"
    echo "Checksum mismatch for the extracted $1 binary (expected sha256 $5), refusing to run it." >&2
    exit 1
  fi
  chmod 755 "$tmp/$3"
  mv -f "$tmp/$3" "/tools/$1"
  rm -rf "$tmp"
}
use_cache_builder() {
  if [ -n "$CACHE_USERNAME" ]; then
    printf '%s' "$CACHE_PASSWORD" | docker login "${CACHE_REGISTRY%%/*}" --username "$CACHE_USERNAME" --password-stdin >/dev/null
  fi
  export BUILDX_CONFIG=/tools/buildx
  if ! docker buildx inspect --bootstrap homerun-cache >/dev/null 2>&1; then
    docker buildx create --name homerun-cache --driver docker-container --driver-opt network=host >/dev/null 2>&1 || true
    docker buildx inspect --bootstrap homerun-cache >/dev/null
  fi
}
platform=""
if [ -n "${BUILD_PLATFORM:-}" ] && [ "${BUILD_PLATFORM#*/}" != "$native" ]; then
  echo "This build server runs $native: building for $BUILD_PLATFORM through QEMU emulation, slower than a native build."
  if ! docker run --rm --privileged "$BINFMT_IMAGE" --install "${BUILD_PLATFORM#*/}" >/dev/null; then
    echo "Couldn't install QEMU on this build server to build for $BUILD_PLATFORM, its Docker daemon has to allow privileged containers." >&2
    exit 1
  fi
  platform=$BUILD_PLATFORM
fi
if [ ! -d "$BUILD_DIR" ]; then
  echo "Build context $BUILD_DIR doesn't exist in the repository." >&2
  exit 1
fi
case "$BUILD_METHOD" in
  dockerfile)
    if [ ! -f "$BUILD_FILE" ]; then
      echo "Dockerfile $BUILD_FILE doesn't exist in the repository." >&2
      exit 1
    fi
    set -- build --progress plain -f "$BUILD_FILE" -t "$IMAGE_TAG" --load
    if [ -n "${BUILD_TARGET:-}" ]; then
      set -- "$@" --target "$BUILD_TARGET"
    fi
    if [ -n "${NO_CACHE:-}" ]; then
      set -- "$@" --no-cache
    fi
    if [ -n "$platform" ]; then
      set -- "$@" --platform "$platform"
    fi
    if [ -n "$CACHE_REF" ]; then
      use_cache_builder
      set -- "$@" --builder homerun-cache --cache-from "type=registry,ref=$CACHE_REF" --cache-to "type=registry,ref=$CACHE_REF,mode=max,ignore-error=true"
    fi
    exec docker buildx "$@" "$BUILD_DIR"
    ;;
  bake)
    if [ ! -f "$BUILD_FILE" ]; then
      echo "Bake file $BUILD_FILE doesn't exist in the repository." >&2
      exit 1
    fi
    cd "$BUILD_DIR"
    definition=$(docker buildx bake --progress quiet -f "$BUILD_FILE" --print "$BUILD_TARGET")
    targets=$(printf '%s\n' "$definition" | awk '/^  "target": [{]/ {inside=1; next} inside && /^  [}]/ {inside=0} inside && /^    "[^"]+": [{]/ {name=$0; sub(/^    "/, "", name); sub(/".*/, "", name); cacheonly=0; next} inside && /"type": "cacheonly"/ {cacheonly=1} inside && /^    [}]/ && !cacheonly {print name}')
    count=$(printf '%s\n' "$targets" | grep -c . || true)
    if [ "$count" != 1 ]; then
      echo "The bake target $BUILD_TARGET resolves to $count targets ($(echo $targets)), pick a single target." >&2
      exit 1
    fi
    set -- bake --progress plain -f "$BUILD_FILE" --set "$targets.tags=$IMAGE_TAG" --set "$targets.output=type=docker"
    if [ -n "${NO_CACHE:-}" ]; then
      set -- "$@" --no-cache
    fi
    if [ -n "$platform" ]; then
      set -- "$@" --set "$targets.platform=$platform"
    fi
    if [ -n "$CACHE_REF" ]; then
      use_cache_builder
      set -- "$@" --builder homerun-cache --set "$targets.cache-from=type=registry,ref=$CACHE_REF" --set "$targets.cache-to=type=registry,ref=$CACHE_REF,mode=max,ignore-error=true"
    fi
    exec docker buildx "$@" "$BUILD_TARGET"
    ;;
  nixpacks)
    fetch "nixpacks-$NIXPACKS_VERSION" "https://github.com/railwayapp/nixpacks/releases/download/v$NIXPACKS_VERSION/nixpacks-v$NIXPACKS_VERSION-$nix.tar.gz" nixpacks "$nix_archive" "$nix_binary"
    set -- build "$BUILD_DIR" --name "$IMAGE_TAG"
    if [ -n "${NO_CACHE:-}" ]; then
      set -- "$@" --no-cache
    fi
    if [ -n "$platform" ]; then
      set -- "$@" --platform "$platform"
    fi
    exec "/tools/nixpacks-$NIXPACKS_VERSION" "$@"
    ;;
  railpack)
    fetch "railpack-$RAILPACK_VERSION" "https://github.com/railwayapp/railpack/releases/download/v$RAILPACK_VERSION/railpack-v$RAILPACK_VERSION-$rail.tar.gz" railpack "$rail_archive" "$rail_binary"
    "/tools/railpack-$RAILPACK_VERSION" prepare "$BUILD_DIR" --plan-out /tmp/railpack-plan.json --info-out /tmp/railpack-info.json
    set -- build --progress plain --build-arg "BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v$RAILPACK_VERSION" -f /tmp/railpack-plan.json -t "$IMAGE_TAG" --load
    if [ -n "${NO_CACHE:-}" ]; then
      set -- "$@" --no-cache
    fi
    if [ -n "$platform" ]; then
      set -- "$@" --platform "$platform"
    fi
    if [ -n "$CACHE_REF" ]; then
      use_cache_builder
      set -- "$@" --builder homerun-cache --cache-from "type=registry,ref=$CACHE_REF" --cache-to "type=registry,ref=$CACHE_REF,mode=max,ignore-error=true"
    fi
    exec docker buildx "$@" "$BUILD_DIR"
    ;;
  heroku|paketo)
    fetch "pack-$PACK_VERSION" "https://github.com/buildpacks/pack/releases/download/v$PACK_VERSION/pack-v$PACK_VERSION-$pk.tgz" pack "$pk_archive" "$pk_binary"
    set -- build "$IMAGE_TAG" --builder "$PACK_BUILDER" --path "$BUILD_DIR" --trust-builder --pull-policy if-not-present --network bridge
    if [ -n "${NO_CACHE:-}" ]; then
      set -- "$@" --clear-cache
    fi
    if [ -n "$platform" ]; then
      set -- "$@" --platform "$platform"
    fi
    exec "/tools/pack-$PACK_VERSION" "$@"
    ;;
  *)
    echo "Unknown build method $BUILD_METHOD" >&2
    exit 1
    ;;
esac
