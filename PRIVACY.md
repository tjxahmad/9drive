# Privacy Policy

This privacy policy covers this copy of 9Drive (https://github.com/tjxahmad/9drive), a self-hosted app based on 9Drive by Zenhosta (https://github.com/zenhosta/9drive). It is run privately by its owner on their own computer for personal use.

## What the app accesses

When you connect a Google account, the app asks Google for:

- your basic profile (name, email address, profile picture), to show which account is connected;
- access to Google Drive, to upload, list, preview, download, rename, move and delete the files it stores in a `9drive` folder in your Drive, and to read storage quota.

## Where data is stored

- Your files stay in your own Google Drive (and any S3/R2 storage you connect yourself).
- The app keeps a small database on the owner's computer: file and folder names, sizes, and the Google access/refresh tokens, which are stored encrypted.
- Nothing is sent to the app author, Zenhosta, or any other third party. The app runs only on the owner's computer (`localhost`).

## Sharing

The app does not sell, share or transfer Google user data to anyone. Files are not made public: public links and sharing are disabled in this version.

## Google API Services User Data Policy

The app's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Removing access and data

- Disconnect an account in the app (Settings), or remove the app's access at https://myaccount.google.com/permissions.
- Deleting the app's local database removes all stored tokens and file lists. Your files remain in your Google Drive.

## Contact

Questions: open an issue at https://github.com/tjxahmad/9drive/issues.
