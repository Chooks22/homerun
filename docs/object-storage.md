# Object storage

**Object Storage** (needs the Object storage permission, under **Storage** in
the sidebar) gives you S3 buckets without paying for a cloud: a built-in object
store Homerun runs for you, plus any S3-compatible provider you connect, side by
side. The page has three tabs: **Buckets**, **Stores** and **Built-in**.
Terraform state kept in these buckets is managed from
[Infrastructure as code](infrastructure-as-code.md#terraform-state).

## The built-in store

**Built-in → Run the built-in object store** starts a single
[Garage](https://garagehq.deuxfleurs.fr) node next to the registry. Its data
lives in Docker volumes, so turning it off stops the container and keeps every
bucket and object for when it's back on. Homerun sets the node up on first start
and gives itself an access key it uses to manage buckets; you never see or need
that key.

Other containers on Homerun's network reach it at `http://homerun-garage:3900`.
To use it from anywhere else, set a hostname under **Publish it**: Traefik
routes that hostname to the store's S3 API with TLS, and the
[DNS automation](dns-automation.md) points it at this server like the
registry's. Only the S3 API is ever published, never Garage's admin API.

The tab shows whether the container runs and how much its buckets hold. Turning
the store on or off and publishing it take effect with **Save**, and run in the
background through the [job queue](scheduling.md#the-job-queue): the notice that
they started has a **View task** button that opens the job and its log.

## Connecting a provider

**Stores → Connect a store** adds any S3-compatible provider: AWS S3, Google
Cloud Storage's interoperability keys, Hetzner Object Storage, Cloudflare R2,
MinIO and the like. Give it a name, the endpoint (scheme and host only, e.g.
`https://fsn1.your-objectstorage.com`), the region (`us-east-1` when left empty)
and an access key. Homerun lists the provider's buckets with the key before
saving it, so a typo never lands. The secret is stored encrypted and never shown
again; editing a store with the secret left empty keeps it. Removing a store
forgets the connection and the Terraform state backends kept on it; the buckets
and their objects stay at the provider.

Requests use path-style addressing (the bucket in the path), which every
S3-compatible store accepts.

## Buckets

**Buckets** lists every bucket on every store, with how many objects it holds
and their size. The built-in store reports exact numbers instantly; for a
provider, Homerun counts by listing at most 10,000 objects and shows `10,000+`
beyond that. A store that can't be listed (unreachable, a revoked key) is
reported above the list instead of hiding the rest, and a public bucket carries
a **Public** badge. **New bucket** opens a page that creates one on the store
you pick; names are 3 to 63 lowercase letters, digits, dots or dashes, and
**Public** makes it public from the start.

Click a bucket for its page. Its **Files** tab browses it like a folder tree (S3
has no real folders: a name with `/` in it reads as one): open a folder,
download a file, delete one, upload files into the folder you're in, or create a
folder. A large folder shows 200 entries at a time, with **Next page**. Uploads
go through Homerun, so keep them to what fits in its memory; a client with an
access key is better for big transfers. Its **Settings** tab has:

- **Endpoint and region** to copy into a client.
- **Public access**: a public bucket's objects can be downloaded by anyone at
  `https://<homerun>/public/<store id>/<bucket>/<key>`, without signing in, on
  the built-in store and on every provider alike: Homerun fetches the object
  with the store's own key and streams it back, ranges included. Listing the
  bucket and uploading still need an access key. Private is the default, and
  turning it off takes effect at once. On the built-in store published at a
  hostname, the link is the plain path-style S3 URL instead,
  `https://<s3 hostname>/<bucket>/<key>`: Traefik sends unsigned `GET`/`HEAD`
  requests for a public bucket on that hostname to Homerun, every signed S3 call
  still goes straight to Garage.
- **Lifecycle**: expire every object a number of days after it was written, or
  leave it empty to keep objects until you delete them. It replaces any
  lifecycle rule the bucket had.
- **Access keys** (built-in store only): a key scoped to this one bucket, with
  read, write and owner permissions. The secret is shown once, as environment
  variables ready to paste. Revoking a key deletes it everywhere. For a
  provider, keys are managed in its own console.
- **Use for backups** adds the bucket as a [backup destination](backups.md):
  with a read/write key of its own on the built-in store, with the store's own
  credentials for a provider. On the built-in store that destination uses the
  published hostname when there is one, the address on Homerun's network
  otherwise.
- **Empty bucket** deletes every object in the bucket and keeps the bucket, its
  keys and settings. You type the bucket's name to confirm.
- **Delete bucket** asks you to type the bucket's name, then offers **Delete**,
  which only works on an empty bucket and refuses one that still holds objects,
  and **Empty and delete**, which asks once more, then deletes every object and
  the bucket. Neither can be undone.
